import {
	CONSOLE_PROTOCOL_VERSION,
	type ConsoleOpEnvelope,
	type ConsoleRelayReply,
	type ConsoleReplyBody,
	type OpenedConsoleFrame,
} from "../../shared/console-protocol.js";
import { ConsoleRelayFrameSchema } from "../../shared/schemas.js";
import type { ConsoleSealer } from "./consoleSealer.js";

////////////////////////////////
//  Interfaces & Types

export interface RelayPumpDeps {
	/** Opens the inbound sealed frame and seals the reply back to the console. */
	sealer: ConsoleSealer;
	handleFrame: (frame: OpenedConsoleFrame) => Promise<ConsoleReplyBody>;
	sendReply: (reply: ConsoleRelayReply) => Promise<{ error?: string }>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Production glue between the evie WebSocket and the console handler. A console frame
 * is sealed end to end (evie relays it opaquely), so the arbiter schema-validates
 * the envelope, OPENS the seal (verifying the console's signature against the
 * owner-signed allowlist + decrypting), dispatches the inner op, and seals the
 * reply back. A malformed or unverifiable frame settles the held console request
 * with a CLEARTEXT error (there is no sealed channel to that unproven console, and
 * it needs a readable reason to prompt enrollment); anything with no usable opId
 * is logged and dropped.
 */
export function createConsoleRelayPump({ sealer, handleFrame, sendReply }: RelayPumpDeps) {
	return function pump(raw: unknown): void {
		void (async () => {
			const parsed = ConsoleRelayFrameSchema.safeParse(raw);
			if (!parsed.success) {
				const opId = (raw as { opId?: unknown } | null)?.opId;
				if (typeof opId === "string" && opId.length > 0) {
					await sendReply({
						type: "console_relay_reply",
						v: CONSOLE_PROTOCOL_VERSION,
						opId,
						error: `Invalid relay frame: ${parsed.error.issues[0]?.message ?? "malformed"}`,
					});
					return;
				}
				console.error(`[console] dropping malformed relay frame with no opId`);
				return;
			}

			const frame = parsed.data;
			let env: ConsoleOpEnvelope;
			try {
				env = sealer.open(frame.signerSignPub, frame.sealed);
			} catch (err) {
				await sendReply({
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `unseal failed: ${(err as Error).message}`,
				});
				return;
			}

			const opened: OpenedConsoleFrame = {
				opId: frame.opId,
				signerSignPub: frame.signerSignPub,
				conversationId: env.conversationId,
				device: env.device,
				op: env.op,
			};
			const body = await handleFrame(opened);

			// Seal the reply back to the console. The signer was just verified as an
			// admitted console, so the box key resolves; a failure here is unexpected and
			// settles the request with a cleartext error rather than stranding it.
			let reply: ConsoleRelayReply;
			try {
				reply = {
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					sealed: sealer.seal(frame.signerSignPub, body),
				};
			} catch (err) {
				reply = {
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `seal failed: ${(err as Error).message}`,
				};
			}

			const result = await sendReply(reply);
			if (result?.error) {
				console.error(`[console] relay reply ${frame.opId.slice(0, 8)} failed: ${result.error}`);
			}
		})().catch((err: Error) => {
			console.error(`[console] relay pump error: ${err.message}`);
		});
	};
}
