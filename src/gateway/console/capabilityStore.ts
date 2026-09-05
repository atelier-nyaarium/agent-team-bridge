import type { Clock } from "../../shared/ambient.js";
import type { Capability, CapabilitySnapshot } from "../../shared/capabilities.js";
import type { CapabilityFoldRecord } from "../../shared/capability-fold.js";
import { admit, foldCapabilitySnapshot } from "../../shared/capability-fold.js";
import type { DurableStore } from "../../shared/durable-store.js";
import { EnabledPluginSchema } from "../../shared/schemas.js";

interface DeviceRecord extends CapabilityFoldRecord {
	capabilities: Capability[];
	// Any authenticated op refreshes expiry liveness.
	lastSeen: number;
	// Only capability reports update conflict recency.
	reportedAt: number;
	// Missing version remains unknown.
	clientVersion?: string;
}

const MAX_DEVICES = 500;

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const LAST_SEEN_FLUSH_FLOOR_MS = 60 * 60 * 1000;

export class CapabilityStore {
	private readonly devices = new Map<string, DeviceRecord>();
	private lastPersistAt = 0;
	private livenessDirty = false;

	constructor(
		private readonly durable: DurableStore,
		private readonly ambient: Clock,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
	) {
		this.restore();
	}

	private now(): number {
		return this.ambient.now();
	}

	report(conversationId: string, capabilities: Capability[] | undefined, clientVersion?: string): void {
		const t = this.now();
		const prior = this.devices.get(conversationId);
		// Omitted capabilities preserve the prior report.
		if (!capabilities) {
			if (prior) {
				this.markSeen(prior, t);
				if (clientVersion) prior.clientVersion = clientVersion;
			}
			return;
		}
		const clean = capabilities.flatMap(admit);
		this.devices.set(conversationId, { capabilities: clean, lastSeen: t, reportedAt: t, clientVersion });
		this.evictOverflow();
		this.persist();
	}

	touch(conversationId: string): void {
		const record = this.devices.get(conversationId);
		if (record) this.markSeen(record, this.now());
	}

	forget(conversationId: string): void {
		if (this.devices.delete(conversationId)) this.persist();
	}

	snapshot(): CapabilitySnapshot {
		// Conflicts use reportedAt, not polling liveness.
		return foldCapabilitySnapshot([...this.devices.values()], this.now(), this.ttlMs);
	}

	sweep(): boolean {
		const cutoff = this.now() - this.ttlMs;
		let removed = false;
		for (const [conversationId, record] of this.devices) {
			if (record.lastSeen < cutoff) {
				this.devices.delete(conversationId);
				removed = true;
			}
		}
		if (removed || this.livenessDirty) this.persist();
		return removed;
	}

	private markSeen(record: DeviceRecord, at: number): void {
		record.lastSeen = at;
		if (at - this.lastPersistAt > LAST_SEEN_FLUSH_FLOOR_MS) this.livenessDirty = true;
	}

	private evictOverflow(): void {
		while (this.devices.size > MAX_DEVICES) {
			let oldestKey: string | undefined;
			let oldestSeen = Number.POSITIVE_INFINITY;
			for (const [key, record] of this.devices) {
				if (record.lastSeen < oldestSeen) {
					oldestSeen = record.lastSeen;
					oldestKey = key;
				}
			}
			if (oldestKey === undefined) return;
			this.devices.delete(oldestKey);
		}
	}

	private persist(): void {
		this.durable.save(Object.fromEntries(this.devices));
		this.lastPersistAt = this.now();
		this.livenessDirty = false;
	}

	private restore(): void {
		const raw = this.durable.load();
		if (!raw || typeof raw !== "object") return;
		for (const [conversationId, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const v = value as Partial<DeviceRecord>;
			if (!Array.isArray(v.capabilities) || typeof v.lastSeen !== "number") continue;
			const capabilities = v.capabilities
				.map((c) => EnabledPluginSchema.safeParse(c))
				.flatMap((r) => (r.success ? [r.data as Capability] : []));
			// Invalidated reports contribute no affirmative empty set.
			if (v.capabilities.length > 0 && capabilities.length === 0) continue;
			this.devices.set(conversationId, {
				capabilities,
				lastSeen: v.lastSeen,
				reportedAt: typeof v.reportedAt === "number" ? v.reportedAt : v.lastSeen,
				clientVersion: typeof v.clientVersion === "string" ? v.clientVersion : undefined,
			});
		}
	}
}
