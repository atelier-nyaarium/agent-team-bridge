import type { ServerWebSocket } from "bun";
import type { PendingDelivery, PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { getAllActiveWs, type TeamRegistry, type WsData } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

/** What became of a message handed to [ChannelDeliveryCoordinator.accept]. All three are answers the
 * sender can act on; none of them loses the message silently. */
export type AcceptOutcome = "delivered" | "queued" | "refused";

export interface ChannelDeliveryDeps {
	store: PendingDeliveryStore;
	registry: TeamRegistry;
	/** Nudges an unconfirmed recipient's handshake ahead of the message, so its reply does not burn a
	 * turn on the reply gate. */
	repushHandshake?: (team: string, subId: string) => unknown;
}

////////////////////////////////
//  Class

/**
 * The one road a channel message travels, whether its session was ready or not.
 *
 * Acceptance is a promise: once this says `delivered` or `queued`, the message is either with the
 * session or on disk waiting for it. It is retired only when the receiver says it emitted the
 * notification - a socket write proves the bytes left, not that anything read them.
 *
 * A peer too old to acknowledge is retired on the write instead, which is exactly the guarantee that
 * peer has today. It is not given a promise its plugin cannot keep.
 */
export class ChannelDeliveryCoordinator {
	constructor(private readonly deps: ChannelDeliveryDeps) {}

	/** Deliver now if the session can take it, hold it if not. */
	accept(delivery: PendingDelivery): AcceptOutcome {
		const outcome = this.deps.store.enqueue(delivery);
		if (outcome === "refused") return "refused";
		// A duplicate is already held; offering it again is what a retry of a lost reply wants.
		return this.offer(delivery) ? "delivered" : "queued";
	}

	/** Hand everything waiting for a team to it, oldest first. Returns how many were offered. */
	drain(team: string): number {
		let offered = 0;
		// A copy: offering can retire rows for a legacy peer, which mutates the queue underneath.
		for (const delivery of [...this.deps.store.listForTeam(team)]) {
			if (this.offer(delivery)) offered++;
		}
		return offered;
	}

	/** The receiver confirmed it emitted this one. */
	acknowledge(deliveryId: string): boolean {
		return this.deps.store.acknowledge(deliveryId);
	}

	/**
	 * Write one delivery to every live socket for its team.
	 *
	 * False when nothing took it, which leaves the row queued for the next drain.
	 */
	private offer(delivery: PendingDelivery): boolean {
		const subs = this.deps.registry.get(delivery.team);
		const sockets = subs ? getAllActiveWs(subs) : [];
		if (sockets.length === 0) return false;

		const payload = JSON.stringify(channelPushPayload(delivery));
		for (const ws of sockets) {
			if (!ws.data.handshakeConfirmed && ws.data.teamName) {
				this.deps.repushHandshake?.(ws.data.teamName, ws.data.subId);
			}
			ws.send(payload);
		}

		// Nobody here can acknowledge, so holding the row would re-offer it on every reconnect and
		// duplicate the message. Retiring now gives an old plugin precisely today's behaviour.
		if (!sockets.some(canAcknowledge)) this.deps.store.acknowledge(delivery.deliveryId);
		return true;
	}
}

////////////////////////////////
//  Functions & Helpers

/** Whether this peer's plugin will send `channel_delivery_ack`. */
function canAcknowledge(ws: ServerWebSocket<WsData>): boolean {
	return (ws.data.deliveryProtocol ?? 0) >= 1;
}

/** The wire shape, built from the stored row rather than from live state, so a message delivered
 * after a restart is byte-for-byte the one that was accepted. */
export function channelPushPayload(delivery: PendingDelivery): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		type: "channel_push",
		from: delivery.from,
		body: delivery.body,
		session_id: delivery.channelJobId,
		delivery_id: delivery.deliveryId,
	};
	if (delivery.messageId) payload.message_id = delivery.messageId;
	if (delivery.files && delivery.files.length > 0) payload.files = delivery.files;
	if (delivery.awareness) payload.awareness = delivery.awareness;
	if (delivery.disposition) payload.disposition = delivery.disposition;
	return payload;
}
