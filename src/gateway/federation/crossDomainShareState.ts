import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

////////////////////////////////
//  Schemas

/** A single per-session share: a local session this Gateway has offered to ONE
 * friend Domain. Keyed by `(sessionTarget, toDomainId)`. This is plain state, NOT
 * an owner-signed artifact: the device's submit op is authenticated by the existing
 * console seal (it is already an admitted console), so no second signature scheme. */
const ShareRecordSchema = z.object({
	// The canonical SessionId target (`gateway/name`) of the shared session. Only
	// devcontainer/loose sessions are ever shared; the host-agent, gateway, and
	// console are never shared (the caller enforces the kind, the store is kind-agnostic).
	sessionTarget: z.string().min(1),
	// The friend Domain id (slug) this session is shared TO.
	toDomainId: z.string().min(1),
	// Last time the session was seen online. Used by the absence auto-forget.
	lastSeenAt: z.number().int(),
});
export type ShareRecord = z.infer<typeof ShareRecordSchema>;

const CrossDomainShareFileSchema = z.object({
	shares: z.array(ShareRecordSchema),
});
type CrossDomainShareFile = z.infer<typeof CrossDomainShareFileSchema>;

////////////////////////////////
//  Class

export const XDOMAIN_SHARE_FILE = "cross-domain-share-state.json";

/** The per-session share set on a Gateway: which local sessions are offered to which
 * friend Domains, persisted to the Gateway's volume (tight perms). Both discovery and
 * the relay read this one source, so an un-share bites without evie. A record keyed by
 * `(sessionTarget, toDomainId)`; one session shared to N Domains is N records. */
export class CrossDomainShareState {
	private file: string;
	private state: CrossDomainShareFile;

	constructor(dataDir: string) {
		this.file = path.join(dataDir, XDOMAIN_SHARE_FILE);
		this.state = this.read();
	}

	private read(): CrossDomainShareFile {
		try {
			const parsed = CrossDomainShareFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
			if (parsed.success) return parsed.data;
		} catch {
			// Absent / unreadable: start empty.
		}
		return { shares: [] };
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
	}

	/** Offer a session to a friend Domain. Idempotent on `(sessionTarget, toDomainId)`:
	 * re-sharing refreshes `lastSeenAt` rather than duplicating. */
	share(sessionTarget: string, toDomainId: string): void {
		const existing = this.state.shares.find(
			(s) => s.sessionTarget === sessionTarget && s.toDomainId === toDomainId,
		);
		if (existing) {
			existing.lastSeenAt = Date.now();
		} else {
			this.state.shares.push({ sessionTarget, toDomainId, lastSeenAt: Date.now() });
		}
		this.persist();
	}

	/** Withdraw a session's share to a friend Domain. */
	unshare(sessionTarget: string, toDomainId: string): void {
		const before = this.state.shares.length;
		this.state.shares = this.state.shares.filter(
			(s) => !(s.sessionTarget === sessionTarget && s.toDomainId === toDomainId),
		);
		if (this.state.shares.length !== before) this.persist();
	}

	/** Whether a session is currently shared to a given friend Domain. */
	isSharedTo(sessionTarget: string, toDomainId: string): boolean {
		return this.state.shares.some((s) => s.sessionTarget === sessionTarget && s.toDomainId === toDomainId);
	}

	/** The session targets shared to a given friend Domain (the slimmed discovery filter). */
	sharesFor(toDomainId: string): string[] {
		return this.state.shares.filter((s) => s.toDomainId === toDomainId).map((s) => s.sessionTarget);
	}

	/** Refresh `lastSeenAt` for every share of a session, so the absence sweep does not
	 * auto-forget it. Called from `teams()` for every online local session (presence keeps a
	 * share fresh) and on a permitted cross-Domain delivery in the relay handler (a live
	 * thread keeps it fresh). The sweep separately suppresses the forget while a cross-Domain
	 * thread is open, so a long-running collaboration is never forgotten mid-stream. */
	touch(sessionTarget: string): void {
		let changed = false;
		const now = Date.now();
		for (const s of this.state.shares) {
			if (s.sessionTarget === sessionTarget) {
				s.lastSeenAt = now;
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	/** A copy of all share records. */
	all(): ShareRecord[] {
		return [...this.state.shares];
	}

	/** Absence auto-forget: drop every share whose session has not been seen for longer
	 * than `ttlMs`, UNLESS `isLive(sessionTarget)` reports a live cross-Domain thread to
	 * that session (a live thread suppresses the forget). Returns the number dropped. */
	sweep(now: number, ttlMs: number, isLive: (sessionTarget: string) => boolean): number {
		const before = this.state.shares.length;
		this.state.shares = this.state.shares.filter((s) => now - s.lastSeenAt <= ttlMs || isLive(s.sessionTarget));
		const removed = before - this.state.shares.length;
		if (removed > 0) this.persist();
		return removed;
	}
}
