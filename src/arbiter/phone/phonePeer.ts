import type { ServerWebSocket } from "bun";
import type { DeviceMailbox } from "../../shared/device-mailbox.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import type { WsData } from "../websocket.js";

////////////////////////////////
//  Class

/**
 * Duck-typed bridge socket for a phone device. It exposes only the surface the
 * arbiter uses on registry sockets (send / readyState / data / ping / close).
 * Because the phone has no live connection, send() appends inbound frames to the
 * device's mailbox instead of writing a wire; the phone drains it by polling.
 * Inserted into the team registry + conversation registry via asWs().
 *
 * The mailbox is resolved through an accessor at append time, never captured,
 * so a TTL-swept-and-recreated store entry cannot orphan deliveries.
 */
export class PhonePeer {
	readonly data: WsData;
	readonly readyState = 1;

	constructor(
		private getMailbox: () => DeviceMailbox,
		device: string,
		conversationId: string,
		subId: string,
		// Notified with the session_id of each inbound agent message, so the
		// handler can scope the phone's respond op to threads it actually received.
		private onInboundSession?: (sessionId: string) => void,
	) {
		this.data = {
			teamName: device,
			subId,
			conversationId,
			mode: "channel",
			missedPings: 0,
			isStale: false,
			handshakeConfirmed: true,
			virtual: true,
		};
	}

	send(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "channel_push") {
			const p = msg as unknown as ChannelPushPayload;
			this.getMailbox().append({
				kind: "message",
				session_id: p.session_id,
				from: p.from,
				body: p.body,
				request_type: p.request_type,
				effort: p.effort,
				is_follow_up: p.is_follow_up,
				files: p.files,
			});
			this.onInboundSession?.(p.session_id);
			return;
		}

		if (msg.type === "response_push") {
			const p = msg as unknown as ResponsePushPayload;
			this.getMailbox().append({
				kind: "reply",
				session_id: p.session_id,
				body: p.response,
				status: p.status,
				replyAsJson: p.replyAsJson,
				question: p.question,
				reason: p.reason,
				files: p.files,
			});
		}
	}

	ping(): void {}

	close(): void {}

	asWs(): ServerWebSocket<WsData> {
		return this as unknown as ServerWebSocket<WsData>;
	}
}
