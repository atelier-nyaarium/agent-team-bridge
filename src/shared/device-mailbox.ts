import type { MailboxEntry, MailboxInput } from "./console-protocol.js";

////////////////////////////////
//  Interfaces & Types

export interface MailboxSnapshot {
	entries: MailboxEntry[];
	cursor: number;
	dropped: number;
	epoch: number;
}

/** A box's full serializable state for durability across an gateway restart. The epoch is
 * preserved on reload so the console's persisted cursor still matches (no spurious flip). */
export interface MailboxSnapshotState {
	epoch: number;
	nextSeq: number;
	dropped: number;
	lastActivity: number;
	entries: MailboxEntry[];
	// dedupeKey -> seq, so idempotent append survives a restart: a relay retry
	// after a deploy must not re-append. Optional - older snapshots omit it.
	seenKeys?: Array<[string, number]>;
	// deviceId -> acked seq, so the slowest-device watermark survives a deploy
	// (else a restart resets it and re-broadens retention). Optional.
	consumerCursors?: Array<[string, number]>;
	// deviceId -> last drain time (ms), so a consumer's idle clock survives a restart
	// instead of resetting (which would delay forgetting a dead device). Optional.
	consumerLastSeen?: Array<[string, number]>;
	// session ids the device received and may therefore respond to. Persisted so a
	// thread delivered before a restart stays respondable after it. Optional.
	respondableSessions?: string[];
}

// The cap is the OOM BACKSTOP, not the primary compactor: the watermark
// (trimToMinCursor) removes entries every device has acked on each drain, so a
// regularly-polled inbox stays small regardless of the cap. The cap only bounds
// UNACKED accumulation for a dark/slow device, so it is generous - a slow console
// keeps its mail instead of silently losing it to LRU (the dropped-gap bug). An
// eviction here is logged, since it is now an exceptional backstop event.
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 100_000_000;
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SWEEP_MS = 300_000;
const DEFAULT_MAX_DEVICES = 500;
const DEFAULT_MAX_SEEN_KEYS = 4096;
const DEFAULT_MAX_RESPONDABLE_SESSIONS = 500;

/** Cheap byte estimate for cap accounting: the body plus the base64 of every
 * attachment, which dominates. Avoids re-serializing the whole entry per append. */
function entryBytes(input: MailboxInput): number {
	let n = input.body?.length ?? 0;
	if (input.files) for (const f of input.files) n += f.base64?.length ?? 0;
	return n;
}

/** Random positive Int31 (the console parses epoch as a signed 32-bit int). The
 * console only compares epochs for equality, so what matters is that a mailbox
 * instance from a restarted gateway can never re-mint an epoch a console still
 * holds from the previous process. A counter base did exactly that: the console
 * could not detect the new instance, its stale cursor acked away every fresh
 * entry, and its seq dedupe silently ate the rest. */
function mintEpoch(): number {
	return 1 + Math.floor(Math.random() * 0x7ffffffe);
}

////////////////////////////////
//  Class

/**
 * Per-device inbound queue drained by the console's poll op. There is no live
 * socket to the console, so delivery (agent message or reply) is always an append
 * here; the console catches up by polling. Append assigns a monotonic seq used as
 * the poll cursor. When the queue exceeds maxEntries the oldest entries are
 * evicted and counted in `dropped`, so a console that polls too slowly can detect
 * the gap.
 *
 * `epoch` distinguishes one mailbox instance from a later one created for the
 * same conversation after eviction. Seq restarts at 1 in a new instance, so a
 * console holding a stale (larger) cursor must reset it when the epoch changes;
 * otherwise its cursor would silently ack away the new instance's first entries.
 *
 * One inbox can be drained by several devices, each a consumer with its own acked
 * cursor. Compaction (trimToMinCursor) only removes entries the slowest consumer
 * has acked, so a fast device never strands a slow one. A consumer idle past its
 * TTL is released by sweepIdleConsumers so a departed device cannot pin compaction.
 */
export class DeviceMailbox {
	private entries: MailboxEntry[] = [];
	private entryBytes: number[] = [];
	private bytesUsed = 0;
	private nextSeq = 1;
	private dropped = 0;
	// dedupeKey -> the seq it first produced. Bounds an at-least-once relay retry
	// to a single append. FIFO-capped; persisted so dedup survives a restart.
	private seenKeys = new Map<string, number>();
	// deviceId -> acked seq. The slowest-device watermark: trimToMinCursor compacts
	// only to min(consumerCursors), so a faster device cannot ack away entries a
	// slower device of the same recipient has not yet drained. Persisted.
	private consumerCursors = new Map<string, number>();
	// deviceId -> last drain time (ms). A consumer idle past the store TTL is dropped
	// by sweepIdleConsumers so a departed device stops pinning the watermark forever.
	// Persisted so the idle clock is not reset to "fresh" by a gateway restart.
	private consumerLastSeen = new Map<string, number>();
	// session ids this device received, so the console may only respond to a thread
	// actually delivered to it. Durable (in the snapshot) so respondability survives
	// a restart, instead of the console being told "Unknown session_id" after a deploy.
	private respondableSessions = new Set<string>();
	private maxEntries: number;
	private maxBytes: number;
	private waiters: Array<() => void> = [];
	readonly epoch: number;
	lastActivity = Date.now();

	constructor(epoch: number, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES) {
		this.epoch = epoch;
		this.maxEntries = maxEntries;
		this.maxBytes = maxBytes;
	}

	get size(): number {
		return this.entries.length;
	}

	get highWater(): number {
		return this.nextSeq - 1;
	}

	touch(): void {
		this.lastActivity = Date.now();
	}

	append(input: MailboxInput, dedupeKey?: string): MailboxEntry {
		if (dedupeKey !== undefined) {
			const seenSeq = this.seenKeys.get(dedupeKey);
			if (seenSeq !== undefined) {
				// Idempotent: an at-least-once relay retry of an already-appended op.
				// Never append a duplicate; return the prior entry if still resident,
				// else a stand-in carrying its original seq.
				const existing = this.entries.find((e) => e.seq === seenSeq);
				return existing ?? { ...input, seq: seenSeq, at: Date.now() };
			}
		}
		const entry: MailboxEntry = { ...input, seq: this.nextSeq++, at: Date.now() };
		this.entries.push(entry);
		this.entryBytes.push(entryBytes(input));
		this.bytesUsed += this.entryBytes[this.entryBytes.length - 1];
		if (dedupeKey !== undefined) this.recordSeen(dedupeKey, entry.seq);
		// Evict the oldest entries until both the count cap and the byte cap hold.
		// Always keep the just-appended entry even if it alone exceeds the byte cap
		// (a single oversized file is rejected upstream; this is only a backstop).
		let evicted = 0;
		while (this.entries.length > this.maxEntries || (this.bytesUsed > this.maxBytes && this.entries.length > 1)) {
			this.bytesUsed -= this.entryBytes.shift() ?? 0;
			this.entries.shift();
			this.dropped += 1;
			evicted++;
		}
		if (evicted > 0) {
			// The watermark is the primary compactor; the cap is an OOM backstop. An
			// eviction here means a device fell far enough behind to drop UNACKED mail
			// (a real gap the console will see), so it is logged, not silent.
			console.warn(
				`[mailbox] OOM backstop evicted ${evicted} unacked entr${evicted === 1 ? "y" : "ies"} (dropped total ${this.dropped})`,
			);
		}
		this.lastActivity = Date.now();
		this.releaseWaiters();
		return entry;
	}

	/** Record dedupeKey -> seq, FIFO-bounded so a flood of unique keys cannot grow
	 * unbounded. A retry older than the cap is implausible. Map iteration is
	 * insertion-ordered, so the first key is the oldest. */
	private recordSeen(key: string, seq: number): void {
		this.seenKeys.set(key, seq);
		while (this.seenKeys.size > DEFAULT_MAX_SEEN_KEYS) {
			const oldest = this.seenKeys.keys().next().value;
			if (oldest === undefined) break;
			this.seenKeys.delete(oldest);
		}
	}

	/**
	 * Resolve when an entry is appended, the timeout elapses, or the mailbox is
	 * torn down - whichever comes first. This is the long-poll hold: the poll op
	 * waits here when the box is empty instead of returning an empty drain.
	 */
	waitForAppend(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = () => {
				clearTimeout(timer);
				const i = this.waiters.indexOf(settle);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve();
			};
			timer = setTimeout(settle, timeoutMs);
			this.waiters.push(settle);
		});
	}

	/** Wake every held poll (append, or the store tearing this instance down). */
	releaseWaiters(): void {
		for (const settle of this.waiters.splice(0)) settle();
	}

	/**
	 * Ack everything at or below `cursor`, then return the entries above it
	 * without removing them. Returned entries are dropped on the next drain whose
	 * cursor covers them, giving at-least-once delivery (the console dedupes by seq).
	 *
	 * Acking is epoch-gated: a cursor is only honored when `epoch` matches this
	 * instance, because seq restarts at 1 in each instance, so a cursor carried
	 * over from an evicted instance would otherwise silently ack away the new
	 * instance's entries (even at the cursor==highWater boundary). When `epoch`
	 * is omitted, fall back to a magnitude guard (only ack within range).
	 *
	 * `dropped` is a cumulative total, never reset server-side: a poll response
	 * lost in transit cannot hide a gap. The console detects new gaps by comparing
	 * against the previous total (or by any non-contiguous seq jump).
	 */
	drain(cursor = 0, epoch?: number, consumerId?: string): MailboxSnapshot {
		// Mark the device alive on every poll (even a cursor-0 first poll that does not
		// yet advance a watermark), so sweepIdleConsumers only forgets a truly silent one.
		// Register its watermark floor at 0 on first sight too: a freshly-joined consumer
		// has acked nothing, so a sibling consumer's ack must not trim past mail this one
		// received but has not yet acked. advanceConsumer raises the floor as it acks.
		if (consumerId !== undefined) {
			this.consumerLastSeen.set(consumerId, Date.now());
			if (!this.consumerCursors.has(consumerId)) this.consumerCursors.set(consumerId, 0);
		}
		// A cursor beyond highWater is proof of a stale instance no matter what
		// the epoch claims (this instance never issued it); honoring it would ack
		// away entries the console has never seen.
		const epochOk = (epoch === undefined || epoch === this.epoch) && cursor <= this.highWater;
		if (cursor > 0 && epochOk) {
			if (consumerId !== undefined) {
				// Watermark path: record this device's progress and compact only to the
				// slowest registered device of this recipient, so a faster device cannot
				// ack away entries a slower one has not yet drained. For a single device
				// this is exactly ack(cursor).
				this.advanceConsumer(consumerId, cursor);
				this.trimToMinCursor();
			} else {
				this.ack(cursor);
			}
		}
		this.lastActivity = Date.now();
		return { entries: [...this.entries], cursor: this.highWater, dropped: this.dropped, epoch: this.epoch };
	}

	/** Record a device's acked seq (monotonic). One entry per device sharing this
	 * recipient inbox; the min across them drives compaction. */
	advanceConsumer(consumerId: string, seq: number): void {
		this.consumerCursors.set(consumerId, Math.max(this.consumerCursors.get(consumerId) ?? 0, seq));
	}

	/** The low watermark: the slowest registered device. 0 when no device has acked
	 * (trim nothing - undelivered mail is retained until a device drains it or the
	 * whole inbox is TTL-evicted). */
	minCursor(): number {
		if (this.consumerCursors.size === 0) return 0;
		let m = Number.POSITIVE_INFINITY;
		for (const c of this.consumerCursors.values()) if (c < m) m = c;
		return m;
	}

	/** Compact entries every device has acked. Not a gap: these reached all devices,
	 * so `dropped` is untouched (unlike the OOM-backstop eviction in append). */
	trimToMinCursor(): void {
		const min = this.minCursor();
		if (min <= 0) return;
		let i = 0;
		while (i < this.entries.length && this.entries[i].seq <= min) i++;
		if (i > 0) {
			for (const b of this.entryBytes.splice(0, i)) this.bytesUsed -= b;
			this.entries.splice(0, i);
		}
	}

	/** Drop a device's cursor when it goes stale past the TTL, so the watermark can
	 * advance past it instead of being pinned forever by an abandoned device. */
	forgetConsumer(consumerId: string): void {
		this.consumerCursors.delete(consumerId);
		this.consumerLastSeen.delete(consumerId);
	}

	/** Forget every consumer idle past ttlMs, then re-trim. A departed device
	 * otherwise pins minCursor() at its last (or zero) cursor and stops compaction
	 * for the live devices that share this inbox. Returns how many were forgotten. */
	sweepIdleConsumers(now: number, ttlMs: number): number {
		let forgotten = 0;
		for (const [consumerId, lastSeen] of this.consumerLastSeen) {
			if (now - lastSeen > ttlMs) {
				this.forgetConsumer(consumerId);
				forgotten++;
			}
		}
		if (forgotten > 0) this.trimToMinCursor();
		return forgotten;
	}

	/** Remember a session id delivered to this device (FIFO-capped) so a later
	 * respond op for it is authorized. Survives a restart via the snapshot. */
	recordSession(sessionId: string): void {
		this.respondableSessions.add(sessionId);
		while (this.respondableSessions.size > DEFAULT_MAX_RESPONDABLE_SESSIONS) {
			const oldest = this.respondableSessions.values().next().value;
			if (oldest === undefined) break;
			this.respondableSessions.delete(oldest);
		}
	}

	canRespond(sessionId: string): boolean {
		return this.respondableSessions.has(sessionId);
	}

	ack(cursor: number): void {
		let i = 0;
		while (i < this.entries.length && this.entries[i].seq <= cursor) i++;
		if (i > 0) {
			for (const b of this.entryBytes.splice(0, i)) this.bytesUsed -= b;
			this.entries.splice(0, i);
		}
	}

	isExpired(now: number, ttlMs: number): boolean {
		return now - this.lastActivity > ttlMs;
	}

	/** Serializable state for durability. Held polls (waiters) are transient and omitted;
	 * the console simply re-polls after the restart. */
	snapshot(): MailboxSnapshotState {
		return {
			epoch: this.epoch,
			nextSeq: this.nextSeq,
			dropped: this.dropped,
			lastActivity: this.lastActivity,
			entries: [...this.entries],
			seenKeys: [...this.seenKeys],
			consumerCursors: [...this.consumerCursors],
			consumerLastSeen: [...this.consumerLastSeen],
			respondableSessions: [...this.respondableSessions],
		};
	}

	/** Rebuild a box from a snapshot, keeping its epoch + seq so the console resumes without
	 * a spurious epoch flip and without re-seeing acked entries. */
	static fromSnapshot(
		s: MailboxSnapshotState,
		maxEntries = DEFAULT_MAX_ENTRIES,
		maxBytes = DEFAULT_MAX_BYTES,
	): DeviceMailbox {
		const box = new DeviceMailbox(s.epoch, maxEntries, maxBytes);
		box.nextSeq = s.nextSeq;
		box.dropped = s.dropped;
		box.lastActivity = s.lastActivity;
		for (const e of s.entries) {
			box.entries.push(e);
			const b = entryBytes(e);
			box.entryBytes.push(b);
			box.bytesUsed += b;
		}
		if (s.seenKeys) for (const [k, v] of s.seenKeys) box.seenKeys.set(k, v);
		if (s.consumerCursors) for (const [k, v] of s.consumerCursors) box.consumerCursors.set(k, v);
		if (s.consumerLastSeen) {
			for (const [k, v] of s.consumerLastSeen) box.consumerLastSeen.set(k, v);
		} else {
			// An older snapshot has no idle clock; seed it from lastActivity so a
			// restored consumer is not immediately swept as idle on the next sweep.
			for (const k of box.consumerCursors.keys()) box.consumerLastSeen.set(k, box.lastActivity);
		}
		if (s.respondableSessions) for (const id of s.respondableSessions) box.respondableSessions.add(id);
		return box;
	}
}

/**
 * Owns one DeviceMailbox per opaque recipient key. The console handler keys it by the
 * Domain ownerId, so one inbox serves all an owner's devices, each tracked as a
 * `consumerId` cursor within the box. Bounded two ways so an attacker minting distinct
 * keys cannot exhaust memory: a store-wide cap (LRU eviction beyond it) and an idle TTL
 * sweep. Both eviction paths fire onEvict so the handler tears down the associated peer
 * state in lockstep.
 */
export class DeviceMailboxStore {
	private mailboxes = new Map<string, DeviceMailbox>();
	private ttlMs: number;
	private maxEntries: number;
	private maxBytes: number;
	private maxDevices: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private onEvictCb: ((device: string) => void) | null = null;

	constructor(opts: { ttlMs?: number; maxEntries?: number; maxBytes?: number; maxDevices?: number } = {}) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxDevices = opts.maxDevices ?? DEFAULT_MAX_DEVICES;
	}

	/** Called for each mailbox evicted (idle sweep or LRU cap), so the owner can
	 * tear down the associated peer state and keep peer lifetime equal to mailbox
	 * lifetime. */
	setOnEvict(cb: (device: string) => void): void {
		this.onEvictCb = cb;
	}

	get size(): number {
		return this.mailboxes.size;
	}

	ensure(device: string): DeviceMailbox {
		let box = this.mailboxes.get(device);
		if (!box) {
			if (this.mailboxes.size >= this.maxDevices) this.evictLeastRecentlyActive();
			box = new DeviceMailbox(mintEpoch(), this.maxEntries, this.maxBytes);
			this.mailboxes.set(device, box);
		}
		return box;
	}

	get(device: string): DeviceMailbox | undefined {
		return this.mailboxes.get(device);
	}

	/** Visit every live mailbox (broadcast delivery, e.g. human notices). */
	forEach(cb: (conversationId: string, box: DeviceMailbox) => void): void {
		for (const [conversationId, box] of this.mailboxes) cb(conversationId, box);
	}

	/** Every box's serializable state, keyed by conversation id, for durability. */
	snapshot(): Record<string, MailboxSnapshotState> {
		const out: Record<string, MailboxSnapshotState> = {};
		for (const [conv, box] of this.mailboxes) out[conv] = box.snapshot();
		return out;
	}

	/** Re-hydrate mailboxes on boot. A box that beat the load (a console polled before the
	 * restore ran) wins, so a live epoch is never replaced by a stale snapshot. */
	restore(data: Record<string, MailboxSnapshotState>): void {
		for (const [conv, s] of Object.entries(data)) {
			if (this.mailboxes.has(conv)) continue;
			this.mailboxes.set(conv, DeviceMailbox.fromSnapshot(s, this.maxEntries, this.maxBytes));
		}
	}

	delete(device: string): void {
		this.mailboxes.get(device)?.releaseWaiters();
		this.mailboxes.delete(device);
	}

	startCleanup(intervalMs = DEFAULT_SWEEP_MS): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.sweepExpired(), intervalMs);
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/** Remove idle mailboxes. Returns the number swept. */
	sweepExpired(now = Date.now()): number {
		let removed = 0;
		for (const [device, box] of this.mailboxes) {
			if (box.isExpired(now, this.ttlMs)) {
				box.releaseWaiters();
				this.mailboxes.delete(device);
				removed++;
				this.onEvictCb?.(device);
			} else {
				// A still-live inbox may hold a departed consumer pinning its watermark.
				box.sweepIdleConsumers(now, this.ttlMs);
			}
		}
		return removed;
	}

	private evictLeastRecentlyActive(): void {
		let oldestDevice: string | null = null;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [device, box] of this.mailboxes) {
			if (box.lastActivity < oldest) {
				oldest = box.lastActivity;
				oldestDevice = device;
			}
		}
		if (oldestDevice !== null) {
			this.mailboxes.get(oldestDevice)?.releaseWaiters();
			this.mailboxes.delete(oldestDevice);
			this.onEvictCb?.(oldestDevice);
		}
	}
}
