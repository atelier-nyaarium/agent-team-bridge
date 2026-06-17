import {
	type OpenedPhoneFrame,
	PHONE_PROTOCOL_VERSION,
	type PhoneOpEnvelope,
	type PhoneRelayReply,
	type PhoneReplyBody,
} from "../../shared/phone-protocol.js";
import { PhoneRelayFrameSchema } from "../../shared/schemas.js";
import type { PhoneSealer } from "./phoneSealer.js";

////////////////////////////////
//  Interfaces & Types

export interface RelayPumpDeps {
	/** Opens the inbound sealed frame and seals the reply back to the phone. */
	sealer: PhoneSealer;
	handleFrame: (frame: OpenedPhoneFrame) => Promise<PhoneReplyBody>;
	sendReply: (reply: PhoneRelayReply) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Production glue between the evie WebSocket and the phone handler. A phone frame
 * is sealed end to end (evie relays it opaquely), so the arbiter schema-validates
 * the envelope, OPENS the seal (verifying the phone's signature against the
 * owner-signed allowlist + decrypting), dispatches the inner op, and seals the
 * reply back. A malformed or unverifiable frame settles the held phone request
 * with a CLEARTEXT error (there is no sealed channel to that unproven phone, and
 * it needs a readable reason to prompt enrollment); anything with no usable opId
 * is logged and dropped.
 */
export function createPhoneRelayPump({ sealer, handleFrame, sendReply }: RelayPumpDeps) {
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
						error: `Invalid relay frame: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
					return;
				}
				console.error(`[phone] dropping malformed relay frame with no opId`);
				return;
			}

			const frame = parsed.data;
			let env: PhoneOpEnvelope;
			try {
				env = sealer.open(frame.signerSignPub, frame.sealed);
			} catch (err) {
				await sendReply({
					type: "phone_relay_reply",
					v: PHONE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `unseal failed: ${(err as Error).message}`,
				});
				return;
			}

			const opened: OpenedPhoneFrame = {
				opId: frame.opId,
				signerSignPub: frame.signerSignPub,
				conversationId: env.conversationId,
				device: env.device,
				op: env.op,
			};
			const body = await handleFrame(opened);

			// Seal the reply back to the phone. The signer was just verified as an
			// admitted phone, so the box key resolves; a failure here is unexpected and
			// settles the request with a cleartext error rather than stranding it.
			let reply: PhoneRelayReply;
			try {
				reply = {
					type: "phone_relay_reply",
					v: PHONE_PROTOCOL_VERSION,
					opId: frame.opId,
					sealed: sealer.seal(frame.signerSignPub, body),
				};
			} catch (err) {
				reply = {
					type: "phone_relay_reply",
					v: PHONE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `seal failed: ${(err as Error).message}`,
				};
			}

			const result = await sendReply(reply);
			if (result?.error) {
				console.error(`[phone] relay reply ${frame.opId.slice(0, 8)} failed: ${result.error}`);
			}
		})().catch((err: Error) => {
			console.error(`[phone] relay pump error: ${err.message}`);
		});
	};
}
