////////////////////////////////
//  Interfaces & Types

import type { ReturnRoute } from "./federation-protocol.js";
import { SessionId } from "./session-id.js";

export type JobState = "waiting" | "timed_out" | "stored";

interface JobEntry<T> {
	id: string;
	from: string;
	to: string;
	fromConversationId: string | null;
	// Set on a job the destination Gateway created for a cross-Gateway send: where its
	// reply must be forwarded (back to the origin Gateway's session). Null for a
	// local job, so `respond` knows to deliver locally instead of forwarding.
	returnRoute: ReturnRoute | null;
	// The cryptographically-VERIFIED remote Domain this cross-Domain job is bound to,
	// or null for a local / same-Domain job. On an origin anchor it is the friend Domain
	// the send was routed TO; on a destination job it is the friend Domain the send came
	// FROM. The relay handler's reply + collision gates key on this, never on the bare,
	// friend-controlled gateway id (which is not unique across Domains).
	dstDomainId: string | null;
	persistent: boolean;
	state: JobState;
	createdAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	resolve: ((result: WaitResult<T>) => void) | null;
	storedResult: T | null;
}

export interface WaitResult<T> {
	delivered: boolean;
	result?: T;
	// Set when the wait was settled by an active expiry (the link to the job's remote Domain
	// was pulled) rather than by a delivery or a plain TTL timeout, so the waiter can report a
	// clear reason instead of an indistinguishable not-delivered.
	error?: string;
}

export interface CreateOptions {
	persistent?: boolean;
	fromConversationId?: string;
	returnRoute?: ReturnRoute;
	// The verified remote Domain a cross-Domain job is bound to (see JobEntry.dstDomainId).
	dstDomainId?: string;
}

/** The cross-Domain binding of a job, read by the relay handler's reply + collision gates.
 * `dstDomainId` is the verified remote Domain the job is bound to (null for a local /
 * same-Domain job). `keyGateway` is the destination gateway parsed from the job's OWN
 * (origin-set, trusted) session key; the reply gate requires the verified sender to match
 * it. `returnGateway` is the origin gateway recorded on the job's return-route (null on an
 * origin anchor); the inbound-send collision gate requires it to match the verified sender.
 * Undefined (the method's return) when no such job exists. */
export interface CrossDomainBinding {
	dstDomainId: string | null;
	keyGateway: string | null;
	returnGateway: string | null;
}

/** The metadata `deliver` hands back so the caller can route the reply. */
export interface DeliverMeta {
	delivered: boolean;
	from: string;
	to: string;
	fromConversationId: string | null;
	returnRoute: ReturnRoute | null;
	persistent: boolean;
	// The verified friend Domain a cross-Domain job is bound to (null for a local /
	// same-Domain job). On a destination job (returnRoute set) the reply forward re-checks
	// the session is still shared to THIS Domain before relaying back to the origin, so a withdrawn share
	// drops an already-accepted send's in-flight reply.
	dstDomainId: string | null;
}

/** A persistent entry in serializable form, for surviving an gateway restart. The
 * transient waiter (resolve/timer) is omitted - it re-arms when a client retries. */
export interface PersistentJobSnapshot<T> {
	id: string;
	from: string;
	to: string;
	fromConversationId: string | null;
	returnRoute: ReturnRoute | null;
	dstDomainId: string | null;
	state: JobState;
	createdAt: number;
	storedResult: T | null;
}

////////////////////////////////
//  Class

export class PendingJobStore<T> {
	private entries = new Map<string, JobEntry<T>>();
	private ttlMs: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(ttlMs = 600_000) {
		this.ttlMs = ttlMs;
	}

	get size(): number {
		return this.entries.size;
	}

	startCleanup(intervalMs = 60_000): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	/**
	 * Create a new job entry. If one already exists for this id, refresh its metadata
	 * (for persistent channel-mode conversations this keeps the existing stored result
	 * intact while resetting the TTL clock).
	 */
	create(id: string, from: string, to: string, opts: CreateOptions = {}): void {
		const { persistent = false, fromConversationId = null, returnRoute = null, dstDomainId } = opts;
		const existing = this.entries.get(id);
		if (existing) {
			// Conversation reuse: keep stored result, refresh metadata.
			existing.from = from;
			existing.to = to;
			existing.fromConversationId = fromConversationId;
			// Keep an existing return-route if this refresh did not carry one.
			if (returnRoute) existing.returnRoute = returnRoute;
			// Keep an existing Domain binding if this refresh did not carry one.
			if (dstDomainId !== undefined) existing.dstDomainId = dstDomainId;
			existing.persistent = persistent || existing.persistent;
			existing.createdAt = Date.now();
			return;
		}
		this.entries.set(id, {
			id,
			from,
			to,
			fromConversationId,
			returnRoute,
			dstDomainId: dstDomainId ?? null,
			persistent,
			state: "waiting",
			createdAt: Date.now(),
			timer: null,
			resolve: null,
			storedResult: null,
		});
	}

	waitForResult(id: string, timeoutMs: number): Promise<WaitResult<T>> {
		const entry = this.entries.get(id);
		if (!entry) return Promise.resolve({ delivered: false });
		return new Promise((resolve) => {
			entry.resolve = resolve;
			entry.timer = setTimeout(() => {
				entry.state = "timed_out";
				entry.timer = null;
				entry.resolve = null;
				resolve({ delivered: false });
			}, timeoutMs);
		});
	}

	deliver(id: string, result: T): DeliverMeta | false {
		const entry = this.entries.get(id);
		if (!entry) return false;

		const meta = (): DeliverMeta => ({
			delivered: true,
			from: entry.from,
			to: entry.to,
			fromConversationId: entry.fromConversationId,
			returnRoute: entry.returnRoute,
			persistent: entry.persistent,
			dstDomainId: entry.dstDomainId,
		});

		if (entry.state === "waiting" && entry.resolve) {
			// Synchronous delivery: someone is waiting via waitForResult()
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
			entry.resolve({ delivered: true, result });
			entry.resolve = null;
			// Persistent entries stay in the store even after a sync delivery.
			if (!entry.persistent) {
				this.entries.delete(id);
			} else {
				entry.state = "stored";
				entry.storedResult = result;
				entry.createdAt = Date.now();
			}
			return meta();
		}

		if (entry.state === "waiting" && !entry.resolve) {
			// Async delivery: channel mode, no one called waitForResult(). Store for polling.
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return meta();
		}

		if (entry.state === "timed_out") {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return meta();
		}

		if (entry.state === "stored") {
			// Re-delivery: channel sessions may receive multiple replies
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return meta();
		}

		return false;
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.timer) clearTimeout(entry.timer);
		this.entries.delete(id);
	}

	/**
	 * Actively expire every open job bound to a remote Domain (the jobs created with
	 * `dstDomainId === dstDomainId`), settling each the same way its TTL timeout would and
	 * removing it, returning the number expired. Used when a cross-Domain link is pulled: the
	 * matching jobs would otherwise stall their waiter until the TTL fires, since no reply can
	 * arrive once the sealer refuses the unlinked peer. A waiting `waitForResult` is resolved
	 * with `{ delivered: false, error }` (the timeout settle path, with an explicit reason);
	 * its timer is cleared and the entry removed. Same-Domain and local jobs (dstDomainId null
	 * or a different Domain) are untouched.
	 */
	expireByDomain(dstDomainId: string, error = "cross-domain link unlinked"): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (entry.dstDomainId !== dstDomainId) continue;
			// The TTL timeout's settle path (see waitForResult): clear the timer, drop the
			// waiter, and resolve it not-delivered. Here we attach an explicit reason and then
			// remove the entry outright (an unlinked job has no reply to poll for later).
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			expired++;
		}
		return expired;
	}

	/**
	 * Actively expire every open job bound to ONE cross-Domain session-and-friend pair: a job
	 * whose `dstDomainId === dstDomainId` AND whose session id resolves to the canonical
	 * `sessionTarget` (`gateway/name`). The per-session counterpart of expireByDomain, used
	 * when a SINGLE session's share to a friend Domain is withdrawn (the friend-wide unlink
	 * uses expireByDomain). Match is on the job's own session-id target, not `entry.to`: a
	 * destination job created for a cross-Domain send stores `entry.to` as the BARE local name
	 * while its id (the origin-set session key) carries the canonical `gateway/name` the share
	 * is keyed by, so the parsed target is the form that lines up with the share key. Each
	 * match is settled through the same not-delivered path the TTL timeout uses (timer cleared,
	 * waiter resolved with `error`) and removed, so an in-flight reply that the sealer would
	 * still forward can no longer strand its waiter. Other sessions and other Domains are
	 * untouched.
	 */
	expireBySession(
		sessionTarget: string,
		dstDomainId: string,
		localGatewayId: string,
		error = "cross-domain session unshared",
	): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (entry.dstDomainId !== dstDomainId) continue;
			if (SessionId.parse(entry.id, localGatewayId)?.target.canonical !== sessionTarget) continue;
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			expired++;
		}
		return expired;
	}

	/**
	 * Non-destructive peek: returns the latest stored result for persistent entries
	 * without removing them. Non-persistent entries retain the consume-on-poll
	 * semantics used by CLI-mode waiting clients.
	 */
	poll(id: string): T | null | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;

		if (entry.state === "stored" && entry.storedResult !== null) {
			const result = entry.storedResult;
			if (!entry.persistent) {
				this.entries.delete(id);
			}
			return result;
		}

		if (entry.state === "timed_out") {
			return null;
		}

		return undefined;
	}

	getIdsForTeam(team: string): string[] {
		const ids: string[] = [];
		for (const [id, entry] of this.entries) {
			if (entry.to === team) ids.push(id);
		}
		return ids;
	}

	/** The cross-Domain binding of a job by its id, or undefined if no such job. See
	 * CrossDomainBinding: the relay handler reads it to gate a cross-Domain reply (origin
	 * anchor) and to refuse a cross-Domain inbound send that would hijack an unrelated job
	 * (destination job). Both gates compare the VERIFIED sender against this binding, never
	 * against the bare gateway id the friend put on the wire. */
	crossDomainBinding(id: string, localGatewayId: string): CrossDomainBinding | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		return {
			dstDomainId: entry.dstDomainId,
			keyGateway: SessionId.parse(entry.id, localGatewayId)?.target.gatewayId ?? null,
			returnGateway: entry.returnRoute?.srcGateway ?? null,
		};
	}

	/** Whether a RECENTLY-ACTIVE persistent cross-Domain thread targets `sessionTarget` (the
	 * canonical `gateway/name`). A cross-Domain job carries a returnRoute; this matches when its
	 * session id resolves to `sessionTarget`, its returnRoute's origin Gateway is a linked
	 * cross-Domain peer (the caller supplies `isCrossDomainPeer`), AND it has been touched
	 * within `maxAgeMs` (create + deliver refresh `createdAt`). The share auto-forget sweep
	 * uses this to suppress forgetting a session with live cross-Domain traffic; recency keeps
	 * a long-dead anchor (a persistent entry that merely once received a message) from
	 * suppressing the forget forever. */
	hasLiveCrossDomainThread(
		sessionTarget: string,
		isCrossDomainPeer: (gatewayId: string) => boolean,
		localGatewayId: string,
		maxAgeMs: number,
		now: number = Date.now(),
	): boolean {
		for (const entry of this.entries.values()) {
			if (!entry.persistent || !entry.returnRoute) continue;
			if (now - entry.createdAt > maxAgeMs) continue;
			if (!isCrossDomainPeer(entry.returnRoute.srcGateway)) continue;
			if (SessionId.parse(entry.id, localGatewayId)?.target.canonical === sessionTarget) return true;
		}
		return false;
	}

	listAll(): Array<{ id: string; from: string; to: string; state: JobState; persistent: boolean }> {
		return [...this.entries.values()].map(({ id, from, to, state, persistent }) => ({
			id,
			from,
			to,
			state,
			persistent,
		}));
	}

	/** The persistent entries (the only ones worth surviving a restart) in serializable
	 * form. A timed-out persistent anchor restores as waiting so a later respond delivers. */
	snapshot(): PersistentJobSnapshot<T>[] {
		const out: PersistentJobSnapshot<T>[] = [];
		for (const e of this.entries.values()) {
			if (!e.persistent) continue;
			out.push({
				id: e.id,
				from: e.from,
				to: e.to,
				fromConversationId: e.fromConversationId,
				returnRoute: e.returnRoute,
				dstDomainId: e.dstDomainId,
				state: e.state === "timed_out" ? "waiting" : e.state,
				createdAt: e.createdAt,
				storedResult: e.storedResult,
			});
		}
		return out;
	}

	/** Re-hydrate persistent entries on boot. A live entry that beat the load wins (never
	 * clobber a registration that raced the restore). */
	restore(rows: PersistentJobSnapshot<T>[]): void {
		for (const r of rows) {
			if (this.entries.has(r.id)) continue;
			this.entries.set(r.id, {
				id: r.id,
				from: r.from,
				to: r.to,
				fromConversationId: r.fromConversationId,
				returnRoute: r.returnRoute,
				// A snapshot from before the Domain binding existed restores as null (a legacy
				// local / same-Domain anchor), so the reply gate hard-denies a cross-Domain
				// reply into it - fail-closed.
				dstDomainId: r.dstDomainId ?? null,
				persistent: true,
				state: r.state,
				createdAt: r.createdAt,
				timer: null,
				resolve: null,
				storedResult: r.storedResult,
			});
		}
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.persistent) continue;
			if (entry.state !== "waiting" && now - entry.createdAt > this.ttlMs) {
				if (entry.timer) clearTimeout(entry.timer);
				this.entries.delete(id);
			}
		}
	}
}
