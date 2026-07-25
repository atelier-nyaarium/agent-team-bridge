import type { DurableStore } from "../../shared/durable-store.js";
import { EnabledPluginSchema } from "../../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

/** One plugin a device reports, plus the agent-facing guidance its manifest carries. */
export interface Capability {
	id: string;
	instructions?: string;
}

interface DeviceRecord {
	capabilities: Capability[];
	// Refreshed by ANY authenticated op from this device, so an always-polling tablet or a phone on
	// the 12-hour idle tier never ages out while it is plainly still here. Drives expiry ONLY.
	lastSeen: number;
	// Written ONLY when a register actually carried a capability list. This is the write-recency
	// arbiter for conflicting instruction text: a device that merely polls often must not outrank
	// one that recently re-registered with fresher guidance.
	reportedAt: number;
}

/** What the endpoint serves. `known: false` means no device has ever reported, which a caller must
 * treat as "no opinion" rather than as an affirmative empty set. */
export interface CapabilitySnapshot {
	known: boolean;
	capabilities: Capability[];
}

////////////////////////////////
//  Functions & Helpers

// Matches DurableOpStore's own conversation bound - the same "how many distinct devices can exist"
// ceiling already established for the console's other per-device durable state.
const MAX_DEVICES = 500;

// Long enough that a phone left off over a holiday keeps its capabilities, short enough that a
// retired install eventually stops voting. Only ever measured against lastSeen.
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// How stale the DURABLE lastSeen may get before a sweep flushes it. Liveness advances on every
// sealed op, so writing it through each time would put a disk write on the poll path; it is only
// ever compared against a 14-day TTL, so an hour of drift changes no decision. Without a flush of
// some kind the durable value only moves when a register carries plugins, and a device that has
// polled daily for weeks is deleted by the first sweep after a restart.
const LAST_SEEN_FLUSH_FLOOR_MS = 60 * 60 * 1000;

////////////////////////////////
//  Class

/**
 * What plugins the owner's consoles have enabled, per device, durably.
 *
 * A session's tools are gated on the UNION across devices: if any one phone has the Designer, an
 * agent gets the Designer tools. The union is the honest reading of "can this reach me anywhere",
 * and it degrades the right way, since a capability disappears only when every device that had it
 * has either said otherwise or gone quiet for two weeks.
 */
export class CapabilityStore {
	private readonly devices = new Map<string, DeviceRecord>();
	private lastPersistAt = 0;
	private livenessDirty = false;

	constructor(
		private readonly durable: DurableStore,
		private readonly ttlMs: number = DEFAULT_TTL_MS,
		private readonly now: () => number = () => Date.now(),
	) {
		this.restore();
	}

	/** Record what a device reports at register. Absent (rather than empty) means the device said
	 * nothing about plugins, so its previous report stands rather than being erased. */
	report(conversationId: string, capabilities: Capability[] | undefined): void {
		const t = this.now();
		const prior = this.devices.get(conversationId);
		if (!capabilities) {
			if (prior) this.markSeen(prior, t);
			return;
		}
		const clean = capabilities
			.map((c) => EnabledPluginSchema.safeParse(c))
			.flatMap((r) => (r.success ? [r.data as Capability] : []));
		this.devices.set(conversationId, { capabilities: clean, lastSeen: t, reportedAt: t });
		this.evictOverflow();
		this.persist();
	}

	/** Note that a device is still here, without changing what it reported. */
	touch(conversationId: string): void {
		const record = this.devices.get(conversationId);
		if (record) this.markSeen(record, this.now());
	}

	/**
	 * The union across every device still within its TTL. On conflicting instruction text for one
	 * capability id, the most recently REPORTED wins - `lastSeen` deliberately does not count, or a
	 * device that only polls would pin stale guidance forever.
	 */
	snapshot(): CapabilitySnapshot {
		const live = [...this.devices.values()].filter((r) => this.now() - r.lastSeen < this.ttlMs);
		if (live.length === 0) return { known: false, capabilities: [] };
		const best = new Map<string, { cap: Capability; reportedAt: number }>();
		for (const record of live) {
			for (const cap of record.capabilities) {
				const prior = best.get(cap.id);
				if (!prior || record.reportedAt > prior.reportedAt)
					best.set(cap.id, { cap, reportedAt: record.reportedAt });
			}
		}
		return {
			known: true,
			capabilities: [...best.values()].map((e) => e.cap).sort((a, b) => a.id.localeCompare(b.id)),
		};
	}

	/** Drop devices that have gone quiet past the TTL, and flush liveness that has drifted past the
	 * floor. Called from the gateway's persist tick, which is what makes this the flush point. */
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

	/** Record that a device is still here, flagging a flush once the durable value has drifted far
	 * enough that a restart would read it as abandoned. */
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
			// A record that reported entries and lost every one of them to validation is unreadable,
			// not a device asserting it has nothing. Keeping it would vote an affirmative empty union
			// and take tools away; dropping it leaves the union with no opinion until it re-registers.
			if (v.capabilities.length > 0 && capabilities.length === 0) continue;
			this.devices.set(conversationId, {
				capabilities,
				lastSeen: v.lastSeen,
				reportedAt: typeof v.reportedAt === "number" ? v.reportedAt : v.lastSeen,
			});
		}
	}
}
