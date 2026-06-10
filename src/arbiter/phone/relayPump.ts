import { PHONE_PROTOCOL_VERSION, type PhoneRelayReply } from "../../shared/phone-protocol.js";
import { PhoneRelayFrameSchema } from "../../shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

export interface RelayPumpDeps {
	handleFrame: (frame: import("../../shared/phone-protocol.js").PhoneRelayFrame) => Promise<PhoneRelayReply>;
	sendReply: (reply: PhoneRelayReply) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Production glue between the evie WebSocket and the phone handler. Frames are
 * phone-authored and relayed opaquely by evie, so they are schema-validated
 * here at the arbiter trust boundary before dispatch. Invalid frames with a
 * usable opId get an ok:false reply (so the held phone request settles);
 * anything else is logged and dropped.
 */
export function createPhoneRelayPump({ handleFrame, sendReply }: RelayPumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const parsed = PhoneRelayFrameSchema.safeParse(raw);

			if (!parsed.success) {
				const opId = (raw as { opId?: unknown } | null)?.opId;
				if (typeof opId === "string" && opId.length > 0) {
					await sendReply({
						type: "phone_relay_reply",
						v: PHONE_PROTOCOL_VERSION,
						opId,
						ok: false,
						error: `Invalid relay frame: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
					return;
				}
				console.error(`[phone] dropping malformed relay frame with no opId`);
				return;
			}

			const reply = await handleFrame(parsed.data);
			const result = await sendReply(reply);
			if (result?.error) {
				console.error(`[phone] relay reply ${parsed.data.opId.slice(0, 8)} failed: ${result.error}`);
			}
		})().catch((err: Error) => {
			console.error(`[phone] relay pump error: ${err.message}`);
		});
	};
}
