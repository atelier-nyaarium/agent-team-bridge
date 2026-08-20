import type { ServerWebSocket } from "bun";
import type { DeviceMailbox } from "../../shared/device-mailbox.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import type { WsData } from "../websocket.js";

////////////////////////////////
//  Class

/**
 * Duck-typed bridge socket for a console device. It exposes only the surface the
 * gateway uses on registry sockets (send / readyState / data / ping / close).
 * Because the console has no live connection, send() appends inbound frames to the
 * device's mailbox instead of writing a wire; the console drains it by polling.
 * Inserted into the team registry + conversation registry via asWs().
 *
 * The mailbox is resolved through an accessor at append time, never captured,
 * so a TTL-swept-and-recreated store entry cannot orphan deliveries.
 */
export class ConsolePeer {
	readonly data: WsData;
	readonly readyState = 1;

	constructor(
		// Returns undefined once the device is torn down, so a late delivery no-ops
		// instead of resurrecting an owner inbox the handler's index no longer tracks.
		private getMailbox: () => DeviceMailbox | undefined,
		device: string,
		conversationId: string,
		subId: string,
		// Notified with the session_id of each inbound agent message, so the
		// handler can scope the console's respond op to threads it actually received.
		private onInboundSession?: (sessionId: string) => void,
		// Qualifies a bare sender before the entry is stored: fanOutConsolePush relays entries
		// verbatim, and a sibling's console stamps its ROUTE Gateway onto any bare name.
		private qualifyFrom: (from: string) => string = (from) => from,
		// Relays the appended entry to every other same-Domain Gateway. A conversation held on THIS
		// Gateway otherwise files its replies in a mailbox the console never polls: the console seals
		// a same-Domain send directly to the target's Gateway, but only ever polls its route one.
		private fanOut?: (entry: Record<string, unknown>) => void,
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
			const box = this.getMailbox();
			if (!box) return;
			const p = msg as unknown as ChannelPushPayload;
			const entry = {
				kind: "message" as const,
				session_id: p.session_id,
				from: p.from === undefined ? undefined : this.qualifyFrom(p.from),
				body: p.body,
				files: p.files,
			};
			box.append(entry);
			this.fanOut?.(entry);
			this.onInboundSession?.(p.session_id);
			return;
		}

		if (msg.type === "response_push") {
			const box = this.getMailbox();
			if (!box) return;
			const p = msg as unknown as ResponsePushPayload;
			const entry = {
				kind: "reply" as const,
				session_id: p.session_id,
				body: p.response,
				status: p.status,
				files: p.files,
			};
			box.append(entry);
			this.fanOut?.(entry);
		}
	}

	ping(): void {}

	close(): void {}

	asWs(): ServerWebSocket<WsData> {
		return this as unknown as ServerWebSocket<WsData>;
	}
}
