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
import { fingerprint } from "../../shared/crypto.js";

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

/** The mirrored Domain allowlist on a Switch (audit R3): the owner root plus the
 * owner-signed admissions / revocations, persisted to the Switch's volume so a
 * revocation bites even while evie is unreachable. Resolution maps a Switch id to
 * its admitted keys for sealing, and a sender key to its admission for unsealing. */
export class Allowlist {
	private file: string;
	private state: AllowlistFile;
	// The owner root pinned out-of-band (FEDERATION_OWNER_SIGN_PUB). When set, a
	// snapshot rooted at any other key is refused - so a malicious / token-holding
	// evie cannot root a fresh Switch at an attacker key (the snapshot is relayed
	// through untrusted evie). Null = trust-on-first-use (convenient, but trusts
	// evie at the bootstrap; pinning is recommended for the untrusted-evie model).
	private readonly pinnedOwner: string | null;
	// Strict mode (FEDERATION_REQUIRE_OWNER_PIN): when set without an out-of-band pin,
	// the Switch refuses to root at all rather than trust-on-first-use. For the
	// untrusted-evie model where TOFU is unacceptable.
	private readonly requireOwnerPin: boolean;

	constructor(dataDir: string, pinnedOwner?: string | null, requireOwnerPin = false) {
		this.file = path.join(dataDir, ALLOWLIST_FILE);
		this.pinnedOwner = pinnedOwner ?? null;
		this.requireOwnerPin = requireOwnerPin;
		this.state = this.read();
		// A pin that disagrees with a persisted root means the Switch was previously
		// rooted at a different key; refuse to serve the stale root.
		if (this.pinnedOwner && this.state.ownerSignPub && this.state.ownerSignPub !== this.pinnedOwner) {
			console.warn(`[allowlist] persisted owner root != pinned owner; clearing the stale root`);
			this.state = { ownerSignPub: null, admissions: [], revocations: [] };
		}
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

	/** The current owner-rooted snapshot, or null before rooting. Mirrors evie's
	 * canonical keyring (the Console syncs it through its home Switch's poll reply). */
	getSnapshot(): DomainSnapshot | null {
		if (!this.state.ownerSignPub) return null;
		return {
			ownerSignPub: this.state.ownerSignPub,
			admissions: this.state.admissions,
			revocations: this.state.revocations,
		};
	}

	/** A short stable version hash of the snapshot, for the Console's poll-based keyring
	 * sync. "" before rooting. Content-addressed, so any admit/revoke changes it. */
	version(): string {
		const snap = this.getSnapshot();
		if (!snap) return "";
		return createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 16);
	}

	/** Set the Domain root once, at enrollment. Refuses to silently re-root an
	 * already-enrolled Switch (recovery is a deliberate, separate path). */
	setOwner(ownerSignPubB64: string): void {
		if (this.requireOwnerPin && !this.pinnedOwner) {
			throw new Error("FEDERATION_REQUIRE_OWNER_PIN is set but no owner pin is configured; refusing to root");
		}
		if (this.pinnedOwner && ownerSignPubB64 !== this.pinnedOwner) {
			throw new Error("owner key does not match the pinned owner");
		}
		if (this.state.ownerSignPub && this.state.ownerSignPub !== ownerSignPubB64) {
			throw new Error("allowlist already rooted at a different owner key");
		}
		if (!this.pinnedOwner && !this.state.ownerSignPub) {
			console.warn(
				`[allowlist] trust-on-first-use: rooting at an owner key with no pin (set FEDERATION_OWNER_SIGN_PUB to verify it out-of-band)`,
			);
		}
		this.state.ownerSignPub = ownerSignPubB64;
		this.persist();
	}

	/** Mirror the Domain state evie pushed (audit R3). Idempotent: replaces the
	 * allowlist with the snapshot's owner-verified entries, so a re-sync converges
	 * rather than accumulating duplicates. Refuses to ROOT at a key other than the
	 * out-of-band pin (untrusted-evie defense), and refuses to silently re-root an
	 * already-rooted Switch (recovery is a deliberate, separate path). */
	applySnapshot(snapshot: DomainSnapshot): void {
		// The snapshot arrives through untrusted evie. If an owner is pinned, the
		// root MUST match it; otherwise evie could root a fresh Switch at any key.
		if (this.pinnedOwner && snapshot.ownerSignPub !== this.pinnedOwner) {
			console.warn(`[allowlist] ignoring domain sync: root does not match the pinned owner key`);
			return;
		}
		// Strict mode: without a pin there is no way to know the snapshot's root is the
		// real owner (it arrived through untrusted evie), so refuse to root at all.
		if (this.requireOwnerPin && !this.pinnedOwner) {
			console.warn(
				`[allowlist] FEDERATION_REQUIRE_OWNER_PIN set but FEDERATION_OWNER_SIGN_PUB is not; refusing to root at an unverified owner key`,
			);
			return;
		}
		if (this.state.ownerSignPub && this.state.ownerSignPub !== snapshot.ownerSignPub) {
			console.warn(`[allowlist] ignoring domain sync rooted at a different owner key`);
			return;
		}
		if (!this.pinnedOwner && !this.state.ownerSignPub) {
			// Auto-capture-then-lock: the captured key becomes the effective pin (a
			// later re-root is refused above). Surface its fingerprint so the operator
			// can optionally promote it to an explicit FEDERATION_OWNER_SIGN_PUB pin.
			console.warn(
				`[allowlist] trust-on-first-use: rooting the Domain at owner key ${fingerprint(snapshot.ownerSignPub)} relayed by evie (now locked; set FEDERATION_OWNER_SIGN_PUB=${snapshot.ownerSignPub} to pin it out-of-band)`,
			);
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

	/** This Switch's own owner-signed admission (newest verified for its signing
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

	/** The admitted keys for a Switch id (its newest non-revoked switch admission), for
	 * sealing a cross-Switch frame to it. */
	resolveSwitch(switchId: string): { signPub: string; boxPub: string } | null {
		if (!this.state.ownerSignPub) return null;
		const best = findAdmission(
			this.state.admissions,
			this.state.ownerSignPub,
			(a) => a.kind === "switch" && a.switchId === switchId,
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
