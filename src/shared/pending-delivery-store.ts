import type { ChannelFile } from "./types.js";

////////////////////////////////
//  Interfaces & Types

/**
 * One channel message accepted for a session that could not take it at the time.
 *
 * Everything needed to deliver it later lives HERE. A queued message whose reply anchor or file
 * bucket had to be reconstructed from live state would not survive the restart this store exists to
 * survive.
 */
export interface PendingDelivery {
	/** Stable per-message identity. A retry of the same send reuses it, which is what makes replay
	 * safe: the receiver acknowledges a duplicate without emitting a second notification. */
	deliveryId: string;
	/** The local canonical team this is for. */
	team: string;
	/** The reply anchor this message belongs to, so a reply still threads after a restart. */
	channelJobId: string;
	from: string;
	body: string;
	files?: ChannelFile[];
	disposition?: string;
	/** Reserved at enqueue rather than taken at delivery. Awareness is destructive to read, so
	 * taking it at delivery would drop it on a crash and re-take it on a replay. */
	awareness?: string;
	/** The file-materialization bucket key, minted with the message and not at delivery. */
	messageId?: string;
	enqueuedAt: number;
}

/** Why an enqueue did not add a row. `duplicate` is a success for the caller: that exact message is
 * already queued, which is what a retry should find. */
export type EnqueueOutcome = "enqueued" | "duplicate" | "refused";

interface Snapshot {
	deliveries: PendingDelivery[];
}

/** Somewhere to keep a snapshot. Narrower than `DurableStore`, which satisfies it structurally: this
 * store wants a sink, not the file mechanics behind one. */
export interface DeliverySnapshotSink {
	load(): unknown | null;
	saveChecked(state: unknown): void;
}

////////////////////////////////
//  Constants

/** Retention. Deliberately its OWN constant: a session record's resume TTL is the same number
 * today, but a message outliving the session it addresses has nowhere to go, and the two answer
 * different questions. */
export const PENDING_DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Capacity. No honest derivation exists for these - they are capacity decisions, chosen so one
 * unreachable session cannot consume the queue every other session shares. */
export const MAX_PENDING_DELIVERIES_PER_TEAM = 200;
export const MAX_PENDING_DELIVERIES = 2_000;

////////////////////////////////
//  Class

/**
 * Messages accepted for a session that was not ready, held until it acknowledges them.
 *
 * The point of the store is that acceptance is a PROMISE. Once a send has been told its message
 * landed, the message must reach the session or come back as an explicit failure; it must never
 * simply evaporate because the session was slow, restarting, or on a machine that was briefly gone.
 *
 * Rows leave on acknowledgement, never on the socket write. A write that succeeded proves the bytes
 * left this process, not that anything consumed them.
 */
export class PendingDeliveryStore {
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

	/**
	 * Hold a message for a team.
	 *
	 * Refuses rather than evicting when full. Dropping somebody's older message to make room for a
	 * newer one would break the same promise this store exists to keep, just more quietly.
	 */
	enqueue(delivery: PendingDelivery): EnqueueOutcome {
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

	/** What is waiting for a team, oldest first. Order is the order it was accepted in. */
	listForTeam(team: string): readonly PendingDelivery[] {
		return this.byTeam.get(team) ?? [];
	}

	/** Retire a delivery the receiver has confirmed. False when it was already retired, which a
	 * duplicate acknowledgement is entitled to be. */
	acknowledge(deliveryId: string): boolean {
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

	/** Give up on everything held for a team, handing the rows back so the caller can report each
	 * one. For a session being forgotten, or a share being withdrawn. */
	failTeam(team: string): PendingDelivery[] {
		const queue = this.byTeam.get(team) ?? [];
		if (queue.length === 0) return [];
		this.byTeam.delete(team);
		for (const d of queue) this.ids.delete(d.deliveryId);
		this.persist();
		return queue;
	}

	/** Drop what has aged out, returning it so expiry can be reported rather than silent. */
	sweep(): PendingDelivery[] {
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

	/** The snapshot shape, exposed so the boot log and tests can read it without reaching inside. */
	snapshot(): Snapshot {
		return { deliveries: [...this.byTeam.values()].flat() };
	}

	private persist(): void {
		// Checked, not best-effort. Every caller here has already been told its message was accepted,
		// so a write this store could not confirm has to reach that caller as a failure.
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

////////////////////////////////
//  Functions & Helpers

/** A restored row is only as trustworthy as the file it came from, so every field a delivery
 * depends on is checked rather than assumed. A row that fails is skipped, never repaired. */
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
