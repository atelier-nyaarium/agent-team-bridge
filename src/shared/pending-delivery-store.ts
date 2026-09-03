import { fenced, MIGRATING } from "./migration-fence.js";
import type { ChannelFile, RidingAwareness } from "./types.js";

/** Queued message with delivery state. */
export interface PendingDelivery {
	/** Stable retry identity. */
	deliveryId: string;
	team: string;
	channelJobId: string;
	from: string;
	body: string;
	files?: ChannelFile[];
	disposition?: string;
	/** Reserved before delivery. */
	awareness?: RidingAwareness;
	/** Materialization bucket key. */
	messageId?: string;
	enqueuedAt: number;
}

export type EnqueueOutcome = "enqueued" | "duplicate" | "refused" | "migrating";

interface Snapshot {
	deliveries: PendingDelivery[];
}

export interface DeliverySnapshotSink {
	load(): unknown | null;
	saveChecked(state: unknown): void;
}

export const PENDING_DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_PENDING_DELIVERIES_PER_TEAM = 200;
export const MAX_PENDING_DELIVERIES = 2_000;

export class PendingDeliveryStore {
	// Rows remain until acknowledgement.
	private readonly byTeam = new Map<string, PendingDelivery[]>();
	private readonly ids = new Set<string>();

	constructor(
		private readonly durable?: DeliverySnapshotSink,
		private readonly ttlMs: number = PENDING_DELIVERY_TTL_MS,
		private readonly maxPerTeam: number = MAX_PENDING_DELIVERIES_PER_TEAM,
		private readonly maxTotal: number = MAX_PENDING_DELIVERIES,
		private readonly now: () => number = Date.now,
	) {
		this.restore();
	}

	get size(): number {
		return this.ids.size;
	}

	/** Refuses when full. */
	enqueue(delivery: PendingDelivery): EnqueueOutcome {
		if (fenced()) return MIGRATING;
		if (this.ids.has(delivery.deliveryId)) return "duplicate";
		const queue = this.byTeam.get(delivery.team) ?? [];
		if (queue.length >= this.maxPerTeam) return "refused";
		if (this.ids.size >= this.maxTotal) return "refused";
		queue.push(delivery);
		this.byTeam.set(delivery.team, queue);
		this.ids.add(delivery.deliveryId);
		this.persist();
		return "enqueued";
	}

	listForTeam(team: string): readonly PendingDelivery[] {
		return this.byTeam.get(team) ?? [];
	}

	acknowledge(deliveryId: string): boolean | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		if (!this.ids.delete(deliveryId)) return false;
		for (const [team, queue] of this.byTeam) {
			const at = queue.findIndex((d) => d.deliveryId === deliveryId);
			if (at < 0) continue;
			queue.splice(at, 1);
			if (queue.length === 0) this.byTeam.delete(team);
			break;
		}
		this.persist();
		return true;
	}

	failTeam(team: string): PendingDelivery[] | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const queue = this.byTeam.get(team) ?? [];
		if (queue.length === 0) return [];
		this.byTeam.delete(team);
		for (const d of queue) this.ids.delete(d.deliveryId);
		this.persist();
		return queue;
	}

	sweep(): PendingDelivery[] | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const cutoff = this.now() - this.ttlMs;
		const expired: PendingDelivery[] = [];
		for (const [team, queue] of [...this.byTeam]) {
			const kept = queue.filter((d) => {
				if (d.enqueuedAt > cutoff) return true;
				expired.push(d);
				this.ids.delete(d.deliveryId);
				return false;
			});
			if (kept.length === 0) this.byTeam.delete(team);
			else this.byTeam.set(team, kept);
		}
		if (expired.length > 0) this.persist();
		return expired;
	}

	snapshot(): Snapshot {
		return { deliveries: [...this.byTeam.values()].flat() };
	}

	private persist(): void {
		// Persistence failure must reach the caller.
		this.durable?.saveChecked(this.snapshot());
	}

	private restore(): void {
		const raw = this.durable?.load();
		if (!raw || typeof raw !== "object") return;
		const rows = (raw as Snapshot).deliveries;
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			if (!isDelivery(row)) continue;
			if (this.ids.has(row.deliveryId)) continue;
			const queue = this.byTeam.get(row.team) ?? [];
			queue.push(row);
			this.byTeam.set(row.team, queue);
			this.ids.add(row.deliveryId);
		}
	}
}

/** Reject incomplete restored rows. */
function isDelivery(row: unknown): row is PendingDelivery {
	if (!row || typeof row !== "object") return false;
	const d = row as Record<string, unknown>;
	return (
		typeof d.deliveryId === "string" &&
		d.deliveryId.length > 0 &&
		typeof d.team === "string" &&
		d.team.length > 0 &&
		typeof d.channelJobId === "string" &&
		typeof d.from === "string" &&
		typeof d.body === "string" &&
		typeof d.enqueuedAt === "number"
	);
}
