import type { MailboxEntry, MailboxInput } from "./phone-protocol.js";

////////////////////////////////
//  Interfaces & Types

export interface MailboxSnapshot {
	entries: MailboxEntry[];
	cursor: number;
	dropped: number;
	epoch: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 30_000_000;
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SWEEP_MS = 300_000;
const DEFAULT_MAX_DEVICES = 500;

/** Cheap byte estimate for cap accounting: the body plus the base64 of every
 * attachment, which dominates. Avoids re-serializing the whole entry per append. */
function entryBytes(input: MailboxInput): number {
	let n = input.body?.length ?? 0;
	if (input.files) for (const f of input.files) n += f.base64?.length ?? 0;
	return n;
}

/** Random positive Int31 (the phone parses epoch as a signed 32-bit int). The
 * phone only compares epochs for equality, so what matters is that a mailbox
 * instance from a restarted arbiter can never re-mint an epoch a phone still
 * holds from the previous process. A counter base did exactly that: the phone
 * could not detect the new instance, its stale cursor acked away every fresh
 * entry, and its seq dedupe silently ate the rest. */
function mintEpoch(): number {
	return 1 + Math.floor(Math.random() * 0x7ffffffe);
}

////////////////////////////////
//  Class

/**
 * Per-device inbound queue drained by the phone's poll op. There is no live
 * socket to the phone, so delivery (agent message or reply) is always an append
 * here; the phone catches up by polling. Append assigns a monotonic seq used as
 * the poll cursor. When the queue exceeds maxEntries the oldest entries are
 * evicted and counted in `dropped`, so a phone that polls too slowly can detect
 * the gap.
 *
 * `epoch` distinguishes one mailbox instance from a later one created for the
 * same conversation after eviction. Seq restarts at 1 in a new instance, so a
 * phone holding a stale (larger) cursor must reset it when the epoch changes;
 * otherwise its cursor would silently ack away the new instance's first entries.
 */
export class DeviceMailbox {
	private entries: MailboxEntry[] = [];
	private entryBytes: number[] = [];
	private bytesUsed = 0;
	private nextSeq = 1;
	private dropped = 0;
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

	append(input: MailboxInput): MailboxEntry {
		const entry: MailboxEntry = { ...input, seq: this.nextSeq++, at: Date.now() };
		this.entries.push(entry);
		this.entryBytes.push(entryBytes(input));
		this.bytesUsed += this.entryBytes[this.entryBytes.length - 1];
		// Evict the oldest entries until both the count cap and the byte cap hold.
		// Always keep the just-appended entry even if it alone exceeds the byte cap
		// (a single oversized file is rejected upstream; this is only a backstop).
		while (this.entries.length > this.maxEntries || (this.bytesUsed > this.maxBytes && this.entries.length > 1)) {
			this.bytesUsed -= this.entryBytes.shift() ?? 0;
			this.entries.shift();
			this.dropped += 1;
		}
		this.lastActivity = Date.now();
		this.releaseWaiters();
		return entry;
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
	 * cursor covers them, giving at-least-once delivery (the phone dedupes by seq).
	 *
	 * Acking is epoch-gated: a cursor is only honored when `epoch` matches this
	 * instance, because seq restarts at 1 in each instance, so a cursor carried
	 * over from an evicted instance would otherwise silently ack away the new
	 * instance's entries (even at the cursor==highWater boundary). When `epoch`
	 * is omitted, fall back to a magnitude guard (only ack within range).
	 *
	 * `dropped` is a cumulative total, never reset server-side: a poll response
	 * lost in transit cannot hide a gap. The phone detects new gaps by comparing
	 * against the previous total (or by any non-contiguous seq jump).
	 */
	drain(cursor = 0, epoch?: number): MailboxSnapshot {
		// A cursor beyond highWater is proof of a stale instance no matter what
		// the epoch claims (this instance never issued it); honoring it would ack
		// away entries the phone has never seen.
		const epochOk = (epoch === undefined || epoch === this.epoch) && cursor <= this.highWater;
		if (cursor > 0 && epochOk) this.ack(cursor);
		this.lastActivity = Date.now();
		return { entries: [...this.entries], cursor: this.highWater, dropped: this.dropped, epoch: this.epoch };
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
}

/**
 * Owns one DeviceMailbox per per-install conversation id. Bounded two ways so an
 * attacker minting distinct ids cannot exhaust memory: a store-wide device cap
 * (LRU eviction beyond it) and an idle TTL sweep. Both eviction paths fire
 * onEvict so the owner tears down the associated peer state in lockstep.
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
