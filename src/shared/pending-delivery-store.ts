import type { Clock } from "./ambient.js";
import { DurableOutbox } from "./durable-outbox.js";
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
	private readonly outbox: DurableOutbox<PendingDelivery>;

	constructor(
		durable: DeliverySnapshotSink | undefined,
		private readonly ambient: Clock,
		private readonly ttlMs: number = PENDING_DELIVERY_TTL_MS,
		private readonly maxPerTeam: number = MAX_PENDING_DELIVERIES_PER_TEAM,
		maxTotal: number = MAX_PENDING_DELIVERIES,
	) {
		this.outbox = new DurableOutbox({
			durable,
			restore: (raw) => {
				if (!raw || typeof raw !== "object") return [];
				const rows = (raw as Snapshot).deliveries;
				if (!Array.isArray(rows)) return [];
				const ids = new Set<string>();
				return rows.filter((row): row is PendingDelivery => {
					if (!isDelivery(row) || ids.has(row.deliveryId)) return false;
					ids.add(row.deliveryId);
					return true;
				});
			},
			serialize: (items) => ({ deliveries: [...this.groupByTeam(items)] }),
			keyOf: (item) => item.deliveryId,
			maxSize: maxTotal,
		});
	}

	get size(): number {
		return this.outbox.size;
	}

	/** Refuses when full. */
	enqueue(delivery: PendingDelivery): EnqueueOutcome {
		if (fenced()) return MIGRATING;
		if (this.outbox.has(delivery.deliveryId)) return "duplicate";
		if (this.listForTeam(delivery.team).length >= this.maxPerTeam) return "refused";
		const result = this.outbox.enqueue(delivery);
		return result === "enqueued" ? result : result === MIGRATING ? MIGRATING : "refused";
	}

	listForTeam(team: string): readonly PendingDelivery[] {
		return this.outbox.values().filter((delivery) => delivery.team === team);
	}

	acknowledge(deliveryId: string): boolean | typeof MIGRATING {
		return this.outbox.retire(deliveryId);
	}

	failTeam(team: string): PendingDelivery[] | typeof MIGRATING {
		return this.outbox.retireWhere((delivery) => delivery.team === team);
	}

	sweep(): PendingDelivery[] | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const cutoff = this.ambient.now() - this.ttlMs;
		return this.outbox.retireWhere((delivery) => delivery.enqueuedAt <= cutoff);
	}

	snapshot(): Snapshot {
		return { deliveries: [...this.groupByTeam(this.outbox.values())] };
	}

	private groupByTeam(items: readonly PendingDelivery[]): PendingDelivery[] {
		const teams = new Map<string, PendingDelivery[]>();
		for (const delivery of items) {
			const queue = teams.get(delivery.team) ?? [];
			queue.push(delivery);
			teams.set(delivery.team, queue);
		}
		return [...teams.values()].flat();
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
