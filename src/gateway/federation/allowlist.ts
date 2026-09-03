import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	type Admission,
	type DomainSnapshot,
	findAdmission,
	resolveAdmitted,
	type SignedAdmission,
	SignedAdmissionSchema,
	type SignedRevocation,
	SignedRevocationSchema,
	verifyAdmission,
	verifyRevocation,
} from "../../shared/admission.js";
import { renameFileSync, writeFileAtomic } from "../../shared/atomic-write.js";

////////////////////////////////
//  Schemas

const AllowlistFileSchema = z.object({
	// The Domain root: the owner key everything verifies under. Null until enrolled.
	ownerSignPub: z.string().nullable(),
	admissions: z.array(SignedAdmissionSchema),
	revocations: z.array(SignedRevocationSchema),
});
export type AllowlistFile = z.infer<typeof AllowlistFileSchema>;

////////////////////////////////
//  Class

export const ALLOWLIST_FILE = "federation-allowlist.json";

export class AllowlistCorruptError extends Error {
	readonly asidePath: string;

	constructor(asidePath: string) {
		super(`allowlist is corrupt; moved aside to ${asidePath}`);
		this.name = "AllowlistCorruptError";
		this.asidePath = asidePath;
	}
}

/** The mirrored Domain allowlist on a Gateway: the owner root plus the
 * owner-signed admissions / revocations, persisted to the Gateway's volume so a
 * revocation bites even while the Router is unreachable. Resolution maps a Gateway id to
 * its admitted keys for sealing, and a sender key to its admission for unsealing. */
export class Allowlist {
	private file: string;
	private state: AllowlistFile;

	constructor(dataDir: string) {
		this.file = path.join(dataDir, ALLOWLIST_FILE);
		this.state = this.read();
	}

	private read(): AllowlistFile {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { ownerSignPub: null, admissions: [], revocations: [] };
		}
		try {
			const parsed = AllowlistFileSchema.safeParse(JSON.parse(raw));
			if (parsed.success) return parsed.data;
		} catch {}
		const aside = `${this.file}.corrupt-${Date.now()}`;
		renameFileSync(this.file, aside);
		console.warn(`[allowlist] invalid allowlist; moved aside to ${aside}`);
		throw new AllowlistCorruptError(aside);
	}

	static writeFile(file: string, state: AllowlistFile): void {
		writeFileAtomic(file, JSON.stringify(state), { mode: 0o600, fsyncFile: true, fsyncDirectory: true });
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		Allowlist.writeFile(this.file, this.state);
	}

	get ownerSignPub(): string | null {
		return this.state.ownerSignPub;
	}

	/** The current owner-rooted snapshot, or null before rooting. Mirrors the Router's
	 * canonical keyring (the Console syncs it through its route Gateway's poll reply). */
	getSnapshot(): DomainSnapshot | null {
		if (!this.state.ownerSignPub) return null;
		return {
			ownerSignPub: this.state.ownerSignPub,
			admissions: this.state.admissions,
			revocations: this.state.revocations,
		};
	}

	/** A short stable version hash of the snapshot, for the Console's poll-based keyring
	 * sync. "" before rooting. Content-addressed, so any admit/revoke changes it. 128 bits
	 * so two distinct keyrings cannot collide and silently skip a revocation. */
	version(): string {
		const snap = this.getSnapshot();
		if (!snap) return "";
		return createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 32);
	}

	/** Set the Domain root once, at enrollment. Refuses to silently re-root an
	 * already-enrolled Gateway (recovery is a deliberate, separate path). */
	setOwner(ownerSignPubB64: string): void {
		if (this.state.ownerSignPub && this.state.ownerSignPub !== ownerSignPubB64) {
			throw new Error("allowlist already rooted at a different owner key");
		}
		this.state.ownerSignPub = ownerSignPubB64;
		this.persist();
	}

	/** Mirror the Domain state the Router pushed. Idempotent: replaces the
	 * allowlist with the snapshot's owner-verified entries, so a re-sync converges
	 * rather than accumulating duplicates. The first snapshot roots the Gateway
	 * (trust-on-first-enroll); a later snapshot rooted at a different owner key is
	 * ignored (recovery is a deliberate, separate path). Returns whether it applied. */
	applySnapshot(snapshot: DomainSnapshot): boolean {
		if (this.state.ownerSignPub && this.state.ownerSignPub !== snapshot.ownerSignPub) {
			console.warn(`[allowlist] ignoring domain sync rooted at a different owner key`);
			return false;
		}
		this.state.ownerSignPub = snapshot.ownerSignPub;
		this.state.admissions = snapshot.admissions.filter((s) => verifyAdmission(s, snapshot.ownerSignPub));
		this.state.revocations = snapshot.revocations.filter((s) => verifyRevocation(s, snapshot.ownerSignPub));
		this.persist();
		return true;
	}

	/** Record an owner-signed admission (verified before it is stored). */
	addAdmission(s: SignedAdmission): boolean {
		if (!this.state.ownerSignPub || !verifyAdmission(s, this.state.ownerSignPub)) return false;
		this.state.admissions.push(s);
		this.persist();
		return true;
	}

	addRevocation(s: SignedRevocation): boolean {
		if (!this.state.ownerSignPub || !verifyRevocation(s, this.state.ownerSignPub)) return false;
		this.state.revocations.push(s);
		this.persist();
		return true;
	}

	/** This Gateway's own owner-signed admission (newest verified for its signing
	 * key), to present at registration so the Router can gate it. Null pre-enrollment. */
	selfAdmission(signPubB64: string): SignedAdmission | null {
		if (!this.state.ownerSignPub) return null;
		let best: SignedAdmission | null = null;
		for (const s of this.state.admissions) {
			if (s.admission.signPub !== signPubB64) continue;
			if (!verifyAdmission(s, this.state.ownerSignPub)) continue;
			if (!best || s.admission.issuedAt > best.admission.issuedAt) best = s;
		}
		return best;
	}

	/** The admitted Admission for a sender signing key, or null. */
	resolveBySignPub(signPubB64: string): Admission | null {
		if (!this.state.ownerSignPub) return null;
		return resolveAdmitted(this.state.admissions, this.state.revocations, this.state.ownerSignPub, signPubB64);
	}

	/** The admitted keys for a Gateway id (its newest non-revoked gateway admission), for
	 * sealing a cross-Gateway frame to it. */
	resolveGateway(gatewayId: string): { signPub: string; boxPub: string } | null {
		if (!this.state.ownerSignPub) return null;
		const best = findAdmission(
			this.state.admissions,
			this.state.ownerSignPub,
			(a) => a.kind === "gateway" && a.gatewayId === gatewayId,
		);
		if (!best) return null;
		// Confirm it is not revoked (resolveAdmitted applies the revocation rule).
		const live = resolveAdmitted(
			this.state.admissions,
			this.state.revocations,
			this.state.ownerSignPub,
			best.signPub,
		);
		return live ? { signPub: live.signPub, boxPub: live.boxPub } : null;
	}
}
