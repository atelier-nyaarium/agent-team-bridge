import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CrossDomainShareTargetSchema } from "../../shared/schemas.js";

type CrossDomainShareTarget = z.infer<typeof CrossDomainShareTargetSchema>;

////////////////////////////////
//  Schemas

/** A per-session share: a local session this Gateway offers to an audience (a specific linked
 * Domain, or everyone the owner trusts), keyed by `(sessionTarget, targetKey)`. Plain state, not an
 * owner-signed artifact: the submit op is already authenticated by the console seal, so no second signature. */
const ShareRecordSchema = z.object({
	// The canonical SessionId target (`domain.gateway.spawn.session`). Only devcontainer/loose sessions are
	// shared; the caller enforces that, and the store is kind-agnostic.
	sessionTarget: z.string().min(1),
	// Who the session is shared TO: a specific linked Domain, or everyone trusted.
	target: CrossDomainShareTargetSchema,
	// Last time the session was seen online. Used by the absence auto-forget.
	lastSeenAt: z.number().int(),
});
export type ShareRecord = z.infer<typeof ShareRecordSchema>;

/** The idempotency key for a share target: one record per (session, audience). */
function targetKey(target: CrossDomainShareTarget): string {
	return target.kind === "domain" ? `domain:${target.domainId}` : "everyone_trusted";
}

const CrossDomainShareFileSchema = z.object({
	shares: z.array(ShareRecordSchema),
});
type CrossDomainShareFile = z.infer<typeof CrossDomainShareFileSchema>;

/** Which Domain(s) a share-state mutation affected, for a caller (the cross-Domain-presence
 * source side) that needs to recompute exactly what changed. A `kind: "domain"` share/unshare/
 * dropDomain names a single Domain precisely; an `kind: "everyone_trusted"` share/unshare cannot
 * name one (it can newly reach, or stop reaching, EVERY currently-linked Domain that has no more
 * specific share of its own), so the caller falls back to a full sweep of its own linked-and-
 * shared roster - the same fallback CrossDomainPeers' own argument-less onChange already needs. */
export type ShareChangeReason = { kind: "domain"; domainId: string } | { kind: "sweep" };

////////////////////////////////
//  Class

export const XDOMAIN_SHARE_FILE = "cross-domain-share-state.json";

/** The per-session share set on a Gateway: which local sessions are offered to which friend
 * Domains, persisted to the Gateway's volume (0600). Discovery and the relay both read this one
 * source, so an un-share takes effect without evie. One session shared to N Domains is N records. */
export class CrossDomainShareState {
	private file: string;
	private state: CrossDomainShareFile;
	private readonly onChange?: (reason: ShareChangeReason) => void;

	/** `onChange` fires once per genuine mutation that actually changed what is shared (never on a
	 * no-op unshare/dropDomain, and always on share - even an idempotent re-share is cheap to
	 * recompute and the registry's own hash-gating absorbs a no-op trigger for free). The
	 * cross-Domain-presence source side's single write hook into this store. */
	constructor(dataDir: string, onChange?: (reason: ShareChangeReason) => void) {
		this.file = path.join(dataDir, XDOMAIN_SHARE_FILE);
		this.state = this.read();
		this.onChange = onChange;
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

	/** Offer a session to an audience. Idempotent on `(sessionTarget, target)`: re-sharing refreshes
	 * `lastSeenAt` rather than duplicating. */
	share(sessionTarget: string, target: CrossDomainShareTarget): void {
		const key = targetKey(target);
		const existing = this.state.shares.find(
			(s) => s.sessionTarget === sessionTarget && targetKey(s.target) === key,
		);
		if (existing) {
			existing.lastSeenAt = Date.now();
		} else {
			this.state.shares.push({ sessionTarget, target, lastSeenAt: Date.now() });
		}
		this.persist();
		this.onChange?.(target.kind === "domain" ? { kind: "domain", domainId: target.domainId } : { kind: "sweep" });
	}

	/** Withdraw a session's share from an audience. Returns whether a record was actually removed, so
	 * the caller can skip the follow-on in-flight-job expiry when the share was already absent. */
	unshare(sessionTarget: string, target: CrossDomainShareTarget): boolean {
		const key = targetKey(target);
		const before = this.state.shares.length;
		this.state.shares = this.state.shares.filter(
			(s) => !(s.sessionTarget === sessionTarget && targetKey(s.target) === key),
		);
		const removed = this.state.shares.length !== before;
		if (removed) {
			this.persist();
			this.onChange?.(
				target.kind === "domain" ? { kind: "domain", domainId: target.domainId } : { kind: "sweep" },
			);
		}
		return removed;
	}

	/** Whether a session is currently shared to a given friend Domain. A SPECIFIC-Domain share matches
	 * that Domain; an EVERYONE-TRUSTED share matches any Domain `isLinked` reports as a linked peer (so
	 * it tracks the live trust set, and can NEVER reach a Domain the owner has not linked). */
	isSharedTo(sessionTarget: string, toDomainId: string, isLinked: (domainId: string) => boolean): boolean {
		return this.state.shares.some(
			(s) =>
				s.sessionTarget === sessionTarget &&
				(s.target.kind === "domain" ? s.target.domainId === toDomainId : isLinked(toDomainId)),
		);
	}

	/** The session targets shared to a given friend Domain (the slimmed discovery filter): the
	 * specific-Domain shares for it, plus every everyone-trusted share when the Domain is a linked peer. */
	sharesFor(toDomainId: string, isLinked: (domainId: string) => boolean): string[] {
		const linked = isLinked(toDomainId);
		return [
			...new Set(
				this.state.shares
					.filter((s) => (s.target.kind === "domain" ? s.target.domainId === toDomainId : linked))
					.map((s) => s.sessionTarget),
			),
		];
	}

	/** Refresh `lastSeenAt` for every share of a session so the absence sweep does not auto-forget
	 * it. Called from `teams()` for each online session and on a permitted cross-Domain delivery. The
	 * sweep also suppresses the forget while a cross-Domain thread is open, so a collaboration survives. */
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

	/** Drop every share offered to a friend Domain, returning the number dropped. The immediate
	 * unlink path: forget what was shared to a Domain when its link is pulled, so a re-link starts
	 * from share-nothing. Distinct from the absence sweep, which auto-forgets per session over time. */
	dropDomain(toDomainId: string): number {
		const before = this.state.shares.length;
		// Only the SPECIFIC-Domain shares for this Domain are dropped; an everyone-trusted share is not
		// Domain-specific and auto-stops reaching it once the link is gone (isLinked turns false).
		this.state.shares = this.state.shares.filter(
			(s) => !(s.target.kind === "domain" && s.target.domainId === toDomainId),
		);
		const removed = before - this.state.shares.length;
		if (removed > 0) {
			this.persist();
			this.onChange?.({ kind: "domain", domainId: toDomainId });
		}
		return removed;
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
		if (removed > 0) {
			this.persist();
			// A dropped share can span any number of Domains in one sweep (unlike a single share()/
			// unshare()/dropDomain() call) - always a full-sweep reason, never a single domainId.
			this.onChange?.({ kind: "sweep" });
		}
		return removed;
	}
}
