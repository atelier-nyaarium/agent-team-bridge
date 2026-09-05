import type { Ambient, IntervalHandle, TimerHandle } from "./ambient.js";
import type { ReturnRoute } from "./federation-protocol.js";
import { type Address, parseStoreKey } from "./session-id.js";

export type JobState = "waiting" | "timed_out" | "stored";

/** Store keys provide trusted share-match inputs. */
function jobAddress(id: string): Address | null {
	const k = parseStoreKey(id);
	return k?.kind === "conv" ? k.address : null;
}

interface JobEntry<T> {
	id: string;
	from: string;
	to: string;
	fromConversationId: string | null;
	returnRoute: ReturnRoute | null;
	dstDomainId: string | null;
	persistent: boolean;
	state: JobState;
	createdAt: number;
	timer: TimerHandle | null;
	resolve: ((result: WaitResult<T>) => void) | null;
	storedResult: T | null;
}

export interface WaitResult<T> {
	delivered: boolean;
	result?: T;
	error?: string;
}

export interface CreateOptions {
	persistent?: boolean;
	fromConversationId?: string;
	returnRoute?: ReturnRoute;
	dstDomainId?: string;
}

export interface CrossDomainBinding {
	/** Verified bindings gate replies, never bare friend gateway ids. */
	dstDomainId: string | null;
	keyGateway: string | null;
	returnGateway: string | null;
}

export interface DeliverMeta {
	delivered: boolean;
	from: string;
	to: string;
	fromConversationId: string | null;
	returnRoute: ReturnRoute | null;
	persistent: boolean;
	dstDomainId: string | null;
}

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

export class PendingJobStore<T> {
	private entries = new Map<string, JobEntry<T>>();
	private ttlMs: number;
	private cleanupTimer: IntervalHandle | null = null;
	private onCrossDomainJobChange: (() => void) | undefined;

	constructor(
		ttlMs: number,
		private readonly ambient: Ambient,
		onCrossDomainJobChange?: () => void,
	) {
		this.ttlMs = ttlMs;
		this.onCrossDomainJobChange = onCrossDomainJobChange;
	}

	private notifyCrossDomainJobChange(entry: JobEntry<T> | undefined): void {
		if (entry?.persistent && entry.returnRoute) this.onCrossDomainJobChange?.();
	}

	get size(): number {
		return this.entries.size;
	}

	startCleanup(intervalMs = 60_000): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = this.ambient.setInterval(() => this.sweep(), intervalMs);
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			this.ambient.clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	create(id: string, from: string, to: string, opts: CreateOptions = {}): void {
		const { persistent = false, fromConversationId = null, returnRoute = null, dstDomainId } = opts;
		const existing = this.entries.get(id);
		if (existing) {
			// Refreshes preserve omitted route and Domain bindings.
			const wasCrossDomain = existing.persistent && existing.returnRoute !== null;
			existing.from = from;
			existing.to = to;
			existing.fromConversationId = fromConversationId;
			if (returnRoute) existing.returnRoute = returnRoute;
			if (dstDomainId !== undefined) existing.dstDomainId = dstDomainId;
			existing.persistent = persistent || existing.persistent;
			existing.createdAt = this.ambient.now();
			if (wasCrossDomain || (existing.persistent && existing.returnRoute)) this.onCrossDomainJobChange?.();
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
			createdAt: this.ambient.now(),
			timer: null,
			resolve: null,
			storedResult: null,
		});
		this.notifyCrossDomainJobChange(this.entries.get(id));
	}

	waitForResult(id: string, timeoutMs: number): Promise<WaitResult<T>> {
		const entry = this.entries.get(id);
		if (!entry) return Promise.resolve({ delivered: false });
		return new Promise((resolve) => {
			entry.resolve = resolve;
			entry.timer = this.ambient.setTimer(() => {
				entry.state = "timed_out";
				entry.timer = null;
				entry.resolve = null;
				resolve({ delivered: false });
			}, timeoutMs);
		});
	}

	targetOf(id: string): string | undefined {
		return this.entries.get(id)?.to;
	}

	askerOf(id: string): string | undefined {
		return this.entries.get(id)?.from;
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
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.resolve({ delivered: true, result });
			entry.resolve = null;
			if (!entry.persistent) {
				this.entries.delete(id);
			} else {
				entry.state = "stored";
				entry.storedResult = result;
				entry.createdAt = this.ambient.now();
			}
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "waiting" && !entry.resolve) {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "timed_out") {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "stored") {
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		return false;
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.timer) this.ambient.clearTimer(entry.timer);
		this.entries.delete(id);
		this.notifyCrossDomainJobChange(entry);
	}

	// Unlink expiry settles waiters immediately and removes jobs.
	expireByDomain(dstDomainId: string, error = "cross-domain link unlinked"): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (entry.dstDomainId !== dstDomainId) continue;
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			this.notifyCrossDomainJobChange(entry);
			expired++;
		}
		return expired;
	}

	// Session expiry matches the canonical store-key address.
	expireBySession(sessionTarget: string, dstDomainId: string, error = "cross-domain session unshared"): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (entry.dstDomainId !== dstDomainId) continue;
			if (jobAddress(entry.id)?.canonical !== sessionTarget) continue;
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			this.notifyCrossDomainJobChange(entry);
			expired++;
		}
		return expired;
	}

	// Persistent results remain available after polling.
	poll(id: string): T | null | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;

		if (entry.state === "stored" && entry.storedResult !== null) {
			const result = entry.storedResult;
			if (!entry.persistent) this.entries.delete(id);
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

	crossDomainBinding(id: string): CrossDomainBinding | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		return {
			dstDomainId: entry.dstDomainId,
			keyGateway: jobAddress(entry.id)?.gateway ?? null,
			returnGateway: entry.returnRoute?.srcGateway ?? null,
		};
	}

	liveCrossDomainJobIds(
		sessionTarget: string,
		isCrossDomainPeer: (gatewayId: string) => boolean,
		maxAgeMs: number,
		now: number,
	): string[] {
		const ids: string[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.persistent || !entry.returnRoute) continue;
			if (now - entry.createdAt > maxAgeMs) continue;
			if (!isCrossDomainPeer(entry.returnRoute.srcGateway)) continue;
			if (jobAddress(entry.id)?.canonical === sessionTarget) ids.push(entry.id);
		}
		return ids;
	}

	hasLiveCrossDomainThread(
		sessionTarget: string,
		isCrossDomainPeer: (gatewayId: string) => boolean,
		maxAgeMs: number,
		now: number,
	): boolean {
		for (const entry of this.entries.values()) {
			if (!entry.persistent || !entry.returnRoute) continue;
			if (now - entry.createdAt > maxAgeMs) continue;
			if (!isCrossDomainPeer(entry.returnRoute.srcGateway)) continue;
			if (jobAddress(entry.id)?.canonical === sessionTarget) return true;
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

	restore(rows: PersistentJobSnapshot<T>[]): void {
		// Missing Domain bindings restore fail-closed as null.
		for (const r of rows) {
			if (this.entries.has(r.id)) continue;
			this.entries.set(r.id, {
				id: r.id,
				from: r.from,
				to: r.to,
				fromConversationId: r.fromConversationId,
				returnRoute: r.returnRoute,
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
		const now = this.ambient.now();
		for (const [id, entry] of this.entries) {
			if (entry.persistent) continue;
			if (entry.state !== "waiting" && now - entry.createdAt > this.ttlMs) {
				if (entry.timer) this.ambient.clearTimer(entry.timer);
				this.entries.delete(id);
			}
		}
	}
}
