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
import type { Clock } from "../../shared/ambient.js";
import { renameFileSync, writeFileAtomic } from "../../shared/atomic-write.js";

const AllowlistFileSchema = z.object({
	// The owner root remains required to verify local revocations offline.
	ownerSignPub: z.string().nullable(),
	domainId: z.string().min(1).max(64).optional(),
	admissions: z.array(SignedAdmissionSchema),
	revocations: z.array(SignedRevocationSchema),
});
export type AllowlistFile = z.infer<typeof AllowlistFileSchema>;

export const ALLOWLIST_FILE = "federation-allowlist.json";

export class AllowlistCorruptError extends Error {
	readonly asidePath: string;

	constructor(asidePath: string) {
		super(`allowlist is corrupt; moved aside to ${asidePath}`);
		this.name = "AllowlistCorruptError";
		this.asidePath = asidePath;
	}
}

export class Allowlist {
	private file: string;
	private state: AllowlistFile;

	constructor(
		dataDir: string,
		private readonly ambient: Clock,
	) {
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
		const aside = `${this.file}.corrupt-${this.ambient.now()}`;
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

	get domainId(): string | null {
		return this.state.domainId ?? null;
	}

	getSnapshot(): DomainSnapshot | null {
		if (!this.state.ownerSignPub) return null;
		return {
			ownerSignPub: this.state.ownerSignPub,
			admissions: this.state.admissions,
			revocations: this.state.revocations,
		};
	}

	version(): string {
		const snap = this.getSnapshot();
		if (!snap) return "";
		return createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 32);
	}

	setOwner(ownerSignPubB64: string): void {
		if (this.state.ownerSignPub && this.state.ownerSignPub !== ownerSignPubB64) {
			throw new Error("allowlist already rooted at a different owner key");
		}
		this.state.ownerSignPub = ownerSignPubB64;
		this.persist();
	}

	setDomainId(domainId: string): void {
		this.state.domainId = domainId;
		this.persist();
	}

	applySnapshot(snapshot: DomainSnapshot): boolean {
		// A different owner root cannot replace the local trust domain.
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

	addAdmission(s: SignedAdmission): boolean {
		// Store admissions only after owner verification.
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

	selfAdmission(signPubB64: string): SignedAdmission | null {
		// Registration presents the newest verified admission for this key.
		if (!this.state.ownerSignPub) return null;
		let best: SignedAdmission | null = null;
		for (const s of this.state.admissions) {
			if (s.admission.signPub !== signPubB64) continue;
			if (!verifyAdmission(s, this.state.ownerSignPub)) continue;
			if (!best || s.admission.issuedAt > best.admission.issuedAt) best = s;
		}
		return best;
	}

	resolveBySignPub(signPubB64: string): Admission | null {
		if (!this.state.ownerSignPub) return null;
		return resolveAdmitted(this.state.admissions, this.state.revocations, this.state.ownerSignPub, signPubB64);
	}

	resolveGateway(gatewayId: string): { signPub: string; boxPub: string } | null {
		// Resolve only the newest live gateway admission.
		if (!this.state.ownerSignPub) return null;
		const best = findAdmission(
			this.state.admissions,
			this.state.ownerSignPub,
			(a) => a.kind === "gateway" && a.gatewayId === gatewayId,
		);
		if (!best) return null;
		const live = resolveAdmitted(
			this.state.admissions,
			this.state.revocations,
			this.state.ownerSignPub,
			best.signPub,
		);
		return live ? { signPub: live.signPub, boxPub: live.boxPub } : null;
	}
}
