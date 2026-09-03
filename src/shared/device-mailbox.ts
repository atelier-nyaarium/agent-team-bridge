import { capFifo } from "./cap-fifo.js";
import type { MailboxEntry, MailboxInput } from "./console-protocol.js";
import { mintEpoch } from "./epoch.js";

////////////////////////////////
//  Interfaces & Types

export interface MailboxSnapshot {
	entries: MailboxEntry[];
	cursor: number;
	dropped: number;
	epoch: number;
}

export type MailboxProvenance = "peer" | "message";

/** Epoch is preserved on reload, so the console's cursor still matches. */
export interface MailboxSnapshotState {
	epoch: number;
	nextSeq: number;
	dropped: number;
	lastActivity: number;
	entries: MailboxEntry[];
	provenance?: MailboxProvenance[];
	// dedupeKey -> seq, so a relay retry does not re-append.
	seenKeys?: Array<[string, number]>;
	// deviceId -> acked seq, surviving a deploy.
	consumerCursors?: Array<[string, number]>;
	// deviceId -> last drain time.
	consumerLastSeen?: Array<[string, number]>;
	// Sessions this device may respond to.
	respondableSessions?: string[];
}

// An OOM backstop, not the primary compactor: trimToMinCursor does the real work.
const DEFAULT_MAX_ENTRIES = 10_000;
// Text only, never file bytes.
const DEFAULT_MAX_BYTES = 64_000_000;
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SWEEP_MS = 300_000;
const DEFAULT_MAX_DEVICES = 500;
const DEFAULT_MAX_SEEN_KEYS = 4096;
const DEFAULT_MAX_RESPONDABLE_SESSIONS = 500;

/** Avoids re-serializing the whole entry per append. */
export function entryBytes(input: MailboxInput | MailboxEntry): number {
	return Buffer.byteLength(JSON.stringify(input), "utf8");
}

/** NOT the ingest schema: reusing it would retroactively delete delivered history. */
function servable(entry: MailboxEntry): boolean {
	const files = (entry as { files?: unknown }).files;
	if (!Array.isArray(files)) return true;
	return files.every((f) => typeof (f as { role?: unknown })?.role === "string");
}

/** Never re-mints an epoch a console still holds, or a stale cursor acks away fresh mail. */
////////////////////////////////
//  Class

/**
 * Per-device inbound queue drained by the console's poll op. No live socket, so delivery is always
 * an append; the console catches up by polling.
 *
 * `epoch` distinguishes an instance from its predecessor after eviction: seq restarts at 1, so a
 * stale cursor across an epoch change would silently ack away the new instance's entries.
 *
 * Several devices drain one inbox, each with its own acked cursor. Compaction removes only what the
 * slowest has acked; an idle consumer past TTL is dropped so it cannot pin compaction forever.
 */
export class DeviceMailbox {
	private entries: MailboxEntry[] = [];
	private entryBytes: number[] = [];
	private entryProvenance: MailboxProvenance[] = [];
	private bytesUsed = 0;
	private nextSeq = 1;
	private dropped = 0;
	// dedupeKey -> first-produced seq. FIFO-capped, persisted.
	private seenKeys = new Map<string, number>();
	// deviceId -> acked seq: the slowest-device watermark. Persisted.
	private consumerCursors = new Map<string, number>();
	// deviceId -> last drain time. Persisted.
	private consumerLastSeen = new Map<string, number>();
	// Sessions this device received. Persisted.
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

	append(input: MailboxInput, dedupeKey?: string, provenance: MailboxProvenance = "message"): MailboxEntry {
		if (dedupeKey !== undefined) {
			const seenSeq = this.seenKeys.get(dedupeKey);
			if (seenSeq !== undefined) {
				// Idempotent: never a duplicate append.
				const existing = this.entries.find((e) => e.seq === seenSeq);
				return existing ?? { ...input, seq: seenSeq, at: Date.now() };
			}
		}
		const entry: MailboxEntry = { ...input, seq: this.nextSeq++, at: Date.now() };
		this.entries.push(entry);
		this.entryBytes.push(entryBytes(entry));
		this.entryProvenance.push(provenance);
		this.bytesUsed += this.entryBytes[this.entryBytes.length - 1];
		if (dedupeKey !== undefined) this.recordSeen(dedupeKey, entry.seq);
		// The just-appended entry is always kept, even alone over the byte cap.
		let evicted = 0;
		while (this.entries.length > this.maxEntries || (this.bytesUsed > this.maxBytes && this.entries.length > 1)) {
			this.evictOneForCapacity();
			evicted++;
		}
		if (evicted > 0) {
			// A real gap: unacked mail dropped.
			console.warn(
				`[mailbox] OOM backstop evicted ${evicted} unacked entr${evicted === 1 ? "y" : "ies"} (dropped total ${this.dropped})`,
			);
		}
		this.lastActivity = Date.now();
		this.releaseWaiters();
		return entry;
	}

	/** Oldest "peer" (mirror chatter) entry first, so a burst of it self-evicts before real mail. */
	private evictOneForCapacity(): void {
		// The just-pushed entry is never a candidate.
		const lastIdx = this.entries.length - 1;
		let idx = -1;
		for (let i = 0; i < lastIdx; i++) {
			if (this.entryProvenance[i] === "peer") {
				idx = i;
				break;
			}
		}
		if (idx === -1) idx = lastIdx > 0 ? 0 : lastIdx;
		this.bytesUsed -= this.entryBytes[idx] ?? 0;
		this.entryBytes.splice(idx, 1);
		this.entryProvenance.splice(idx, 1);
		this.entries.splice(idx, 1);
		this.dropped += 1;
	}

	/** FIFO-bounded. A retry older than the cap is implausible. */
	private recordSeen(key: string, seq: number): void {
		this.seenKeys.set(key, seq);
		capFifo(this.seenKeys, DEFAULT_MAX_SEEN_KEYS);
	}

	/** The long-poll hold: waits here when the box is empty instead of returning empty. */
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

	/** Wake every held poll. */
	releaseWaiters(): void {
		for (const settle of this.waiters.splice(0)) settle();
	}

	/**
	 * Ack at or below `cursor`, return the rest without removing them: at-least-once delivery.
	 *
	 * Epoch-gated: a cursor from an evicted instance must never ack away the new one's entries.
	 * `dropped` is cumulative, never reset, so a lost poll response cannot hide a gap.
	 */
	drain(cursor = 0, epoch?: number, consumerId?: string): MailboxSnapshot {
		// Alive on every poll, floored at 0 on first sight.
		if (consumerId !== undefined) {
			this.consumerLastSeen.set(consumerId, Date.now());
			if (!this.consumerCursors.has(consumerId)) this.consumerCursors.set(consumerId, 0);
		}
		// Beyond highWater proves a stale instance regardless of the claimed epoch.
		const epochOk = (epoch === undefined || epoch === this.epoch) && cursor <= this.highWater;
		if (cursor > 0 && epochOk) {
			if (consumerId !== undefined) {
				// Compacts only to the slowest registered device.
				this.advanceConsumer(consumerId, cursor);
				this.trimToMinCursor();
			} else {
				this.ack(cursor);
			}
		}
		this.lastActivity = Date.now();
		return { entries: [...this.entries], cursor: this.highWater, dropped: this.dropped, epoch: this.epoch };
	}

	/** Monotonic. The min across devices drives compaction. */
	advanceConsumer(consumerId: string, seq: number): void {
		this.consumerCursors.set(consumerId, Math.max(this.consumerCursors.get(consumerId) ?? 0, seq));
	}

	/** 0 when no device has acked: trims nothing. */
	minCursor(): number {
		if (this.consumerCursors.size === 0) return 0;
		let m = Number.POSITIVE_INFINITY;
		for (const c of this.consumerCursors.values()) if (c < m) m = c;
		return m;
	}

	/** Not a gap: `dropped` stays untouched. */
	trimToMinCursor(): void {
		const min = this.minCursor();
		if (min <= 0) return;
		let i = 0;
		while (i < this.entries.length && this.entries[i].seq <= min) i++;
		if (i > 0) {
			for (const b of this.entryBytes.splice(0, i)) this.bytesUsed -= b;
			this.entryProvenance.splice(0, i);
			this.entries.splice(0, i);
		}
	}

	/** Frees the watermark from an abandoned device. */
	forgetConsumer(consumerId: string): void {
		this.consumerCursors.delete(consumerId);
		this.consumerLastSeen.delete(consumerId);
	}

	/** A departed device otherwise pins minCursor() forever. */
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

	/** FIFO-capped, so a later respond op is authorized. */
	recordSession(sessionId: string): void {
		this.respondableSessions.add(sessionId);
		capFifo(this.respondableSessions, DEFAULT_MAX_RESPONDABLE_SESSIONS);
	}

	canRespond(sessionId: string): boolean {
		return this.respondableSessions.has(sessionId);
	}

	ack(cursor: number): void {
		let i = 0;
		while (i < this.entries.length && this.entries[i].seq <= cursor) i++;
		if (i > 0) {
			for (const b of this.entryBytes.splice(0, i)) this.bytesUsed -= b;
			this.entryProvenance.splice(0, i);
			this.entries.splice(0, i);
		}
	}

	isExpired(now: number, ttlMs: number): boolean {
		return now - this.lastActivity > ttlMs;
	}

	/** Held polls are transient and omitted; the console re-polls. */
	snapshot(): MailboxSnapshotState {
		return {
			epoch: this.epoch,
			nextSeq: this.nextSeq,
			dropped: this.dropped,
			lastActivity: this.lastActivity,
			entries: [...this.entries],
			provenance: [...this.entryProvenance],
			seenKeys: [...this.seenKeys],
			consumerCursors: [...this.consumerCursors],
			consumerLastSeen: [...this.consumerLastSeen],
			respondableSessions: [...this.respondableSessions],
		};
	}

	/** Checked on the way OUT: one undecodable entry would otherwise fail the whole poll batch
	 * forever, since the cursor that never advances keeps draining and never sweeps it either. */
	static fromSnapshot(
		s: MailboxSnapshotState,
		maxEntries = DEFAULT_MAX_ENTRIES,
		maxBytes = DEFAULT_MAX_BYTES,
	): DeviceMailbox {
		const box = new DeviceMailbox(s.epoch, maxEntries, maxBytes);
		box.nextSeq = s.nextSeq;
		box.dropped = s.dropped;
		box.lastActivity = s.lastActivity;
		const droppedSeqs = new Set<number>();
		for (const [sourceIndex, e] of s.entries.entries()) {
			if (!servable(e)) {
				// The count is the ONLY signal the console has.
				box.dropped++;
				droppedSeqs.add(e.seq);
				continue;
			}
			box.entries.push(e);
			const b = entryBytes(e);
			box.entryBytes.push(b);
			// Remove after 2026-11-30. Snapshots predating recorded provenance carry only the wire
			// `kind`, and those entries were already admitted under it.
			box.entryProvenance.push(s.provenance?.[sourceIndex] ?? (e.kind === "peer" ? "peer" : "message"));
			box.bytesUsed += b;
		}
		if (droppedSeqs.size > 0) {
			console.error(`[mailbox] dropped ${droppedSeqs.size} unservable entr(ies) at restore`);
		}
		// A dropped entry's dedupe key goes with it, or the healing retry dedupes away too.
		if (s.seenKeys) for (const [k, v] of s.seenKeys) if (!droppedSeqs.has(v)) box.seenKeys.set(k, v);
		if (s.consumerCursors) for (const [k, v] of s.consumerCursors) box.consumerCursors.set(k, v);
		if (s.consumerLastSeen) {
			for (const [k, v] of s.consumerLastSeen) box.consumerLastSeen.set(k, v);
		} else {
			// No idle clock on an older snapshot.
			for (const k of box.consumerCursors.keys()) box.consumerLastSeen.set(k, box.lastActivity);
		}
		if (s.respondableSessions) for (const id of s.respondableSessions) box.respondableSessions.add(id);
		return box;
	}
}

/** Bounded two ways against a key-minting attacker: an LRU cap and an idle TTL sweep. Both fire
 * onEvict so the handler tears down peer state in lockstep. */
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

	/** Keeps peer lifetime equal to mailbox lifetime. */
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

	/** Keyed by conversation id. */
	snapshot(): Record<string, MailboxSnapshotState> {
		const out: Record<string, MailboxSnapshotState> = {};
		for (const [conv, box] of this.mailboxes) out[conv] = box.snapshot();
		return out;
	}

	/** A box that beat the load wins: a live epoch is never replaced by a stale one. */
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
