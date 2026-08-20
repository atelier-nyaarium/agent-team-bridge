import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import type { WsData } from "../websocket.js";

////////////////////////////////
//  Class

/**
 * Duck-typed bridge socket for a console device. It exposes only the surface the
 * gateway uses on registry sockets (send / readyState / data / ping / close).
 * Because the console has no live connection, send() hands inbound frames to the
 * owner-delivery funnel (deliverToOwner) instead of writing a wire; the console
 * drains the mailbox by polling. Inserted into the team registry + conversation
 * registry via asWs().
 */
export class ConsolePeer {
	readonly data: WsData;
	readonly readyState = 1;

	constructor(
		// The owner-delivery funnel, pre-bound to this device's liveness accessor by
		// consoleDevices. Returns false once the device is torn down, so a late delivery
		// no-ops instead of resurrecting an owner inbox the handler no longer tracks.
		private deliver: (entry: ConsolePushEntry, dedupeKey: string) => boolean,
		device: string,
		conversationId: string,
		subId: string,
		// Notified with the session_id of each inbound agent message, so the
		// handler can scope the console's respond op to threads it actually received.
		private onInboundSession?: (sessionId: string) => void,
		// Qualifies a bare sender before the entry is stored: fanOutConsolePush relays entries
		// verbatim, and a sibling's console stamps its ROUTE Gateway onto any bare name.
		private qualifyFrom: (from: string) => string = (from) => from,
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

	// message_id (present whenever files ride along) is the only stable identity a push
	// carries, so it keys the dedupe; without one, a fresh key per delivery preserves the
	// pre-funnel semantics (idempotent per RELAY retry, not per push re-send).
	private static dedupeKeyFor(sessionId: string, messageId: string | undefined): string {
		return messageId ? `push:${sessionId}:${messageId}` : crypto.randomUUID();
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
			const entry = {
				kind: "message" as const,
				session_id: p.session_id,
				from: p.from === undefined ? undefined : this.qualifyFrom(p.from),
				body: p.body,
				files: p.files,
			};
			if (!this.deliver(entry, ConsolePeer.dedupeKeyFor(p.session_id, p.message_id))) return;
			this.onInboundSession?.(p.session_id);
			return;
		}

		if (msg.type === "response_push") {
			const p = msg as unknown as ResponsePushPayload;
			const entry = {
				kind: "reply" as const,
				session_id: p.session_id,
				body: p.response,
				status: p.status,
				files: p.files,
			};
			this.deliver(entry, ConsolePeer.dedupeKeyFor(p.session_id, p.message_id));
		}
	}

	ping(): void {}

	close(): void {}

	asWs(): ServerWebSocket<WsData> {
		return this as unknown as ServerWebSocket<WsData>;
	}
}
