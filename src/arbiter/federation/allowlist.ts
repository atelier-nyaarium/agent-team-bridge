import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	type Admission,
	type DomainSnapshot,
	resolveAdmitted,
	type SignedAdmission,
	SignedAdmissionSchema,
	type SignedRevocation,
	SignedRevocationSchema,
	verifyAdmission,
	verifyRevocation,
} from "../../shared/admission.js";

////////////////////////////////
//  Schemas

const AllowlistFileSchema = z.object({
	// The Domain root: the owner key everything verifies under. Null until enrolled.
	ownerSignPub: z.string().nullable(),
	admissions: z.array(SignedAdmissionSchema),
	revocations: z.array(SignedRevocationSchema),
});
type AllowlistFile = z.infer<typeof AllowlistFileSchema>;

////////////////////////////////
//  Class

const ALLOWLIST_FILE = "federation-allowlist.json";

/** The mirrored Domain allowlist on a Host (audit R3): the owner root plus the
 * owner-signed admissions / revocations, persisted to the Host's volume so a
 * revocation bites even while evie is unreachable. Resolution maps a Host id to
 * its admitted keys for sealing, and a sender key to its admission for unsealing. */
export class Allowlist {
	private file: string;
	private state: AllowlistFile;

	constructor(dataDir: string) {
		this.file = path.join(dataDir, ALLOWLIST_FILE);
		this.state = this.read();
	}

	private read(): AllowlistFile {
		try {
			const parsed = AllowlistFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
			if (parsed.success) return parsed.data;
		} catch {
			// Absent / unreadable: start empty.
		}
		return { ownerSignPub: null, admissions: [], revocations: [] };
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
	}

	get ownerSignPub(): string | null {
		return this.state.ownerSignPub;
	}

	/** Set the Domain root once, at enrollment. Refuses to silently re-root an
	 * already-enrolled Host (recovery is a deliberate, separate path). */
	setOwner(ownerSignPubB64: string): void {
		if (this.state.ownerSignPub && this.state.ownerSignPub !== ownerSignPubB64) {
			throw new Error("allowlist already rooted at a different owner key");
		}
		this.state.ownerSignPub = ownerSignPubB64;
		this.persist();
	}

	/** Mirror the Domain state evie pushed (audit R3). Idempotent: replaces the
	 * allowlist with the snapshot's owner-verified entries, so a re-sync converges
	 * rather than accumulating duplicates. Ignores a snapshot for a different owner
	 * root (recovery is a deliberate, separate path). */
	applySnapshot(snapshot: DomainSnapshot): void {
		if (this.state.ownerSignPub && this.state.ownerSignPub !== snapshot.ownerSignPub) {
			console.warn(`[allowlist] ignoring domain sync rooted at a different owner key`);
			return;
		}
		this.state.ownerSignPub = snapshot.ownerSignPub;
		this.state.admissions = snapshot.admissions.filter((s) => verifyAdmission(s, snapshot.ownerSignPub));
		this.state.revocations = snapshot.revocations.filter((s) => verifyRevocation(s, snapshot.ownerSignPub));
		this.persist();
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

	/** This Host's own owner-signed admission (newest verified for its signing
	 * key), to present at registration so evie can gate it. Null pre-enrollment. */
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

	/** The admitted keys for a Host id (its newest non-revoked host admission), for
	 * sealing a cross-Host frame to it. */
	resolveHost(hostId: string): { signPub: string; boxPub: string } | null {
		if (!this.state.ownerSignPub) return null;
		let best: Admission | null = null;
		for (const s of this.state.admissions) {
			const a = s.admission;
			if (a.kind !== "host" || a.hostId !== hostId) continue;
			if (!verifyAdmission(s, this.state.ownerSignPub)) continue;
			if (!best || a.issuedAt > best.issuedAt) best = a;
		}
		if (!best) return null;
		// Confirm it is not revoked (resolveBySignPub applies the revocation rule).
		const live = resolveAdmitted(
			this.state.admissions,
			this.state.revocations,
			this.state.ownerSignPub,
			best.signPub,
		);
		return live ? { signPub: live.signPub, boxPub: live.boxPub } : null;
	}
}
