import {
	CONSOLE_PROTOCOL_VERSION,
	type ConsoleOpEnvelope,
	type ConsoleRelayReply,
	type ConsoleReplyBody,
	type OpenedConsoleFrame,
} from "../../shared/console-protocol.js";
import { MAX_RELAY_FRAME_BYTES } from "../../shared/evie-protocol.js";
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
 * is sealed end to end (evie relays it opaquely), so the gateway schema-validates
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
			let ownerSignPub: string;
			try {
				({ env, ownerSignPub } = sealer.open(frame.signerSignPub, frame.sealed));
			} catch (err) {
				const message = (err as Error).message;
				console.error(`[console] unseal failed for opId ${frame.opId.slice(0, 8)}: ${message}`);
				await sendReply({
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `unseal failed: ${message}`,
				});
				return;
			}

			const opened: OpenedConsoleFrame = {
				opId: frame.opId,
				signerSignPub: frame.signerSignPub,
				ownerSignPub,
				conversationId: env.conversationId,
				device: env.device,
				op: env.op,
			};
			const body = await handleFrame(opened);
			// Every op EXCEPT the steady stream of held polls, which stay silent by design (see
			// consoleHandler's own note). Without this a console op that is answered but refused
			// leaves no trace at all: the relay layer only logs its own failures, and a refusal is
			// a successful relay carrying a bad answer.
			if (env.op.kind !== "poll") {
				const failed = (body as { error?: unknown } | null)?.error;
				console.log(
					`[console] op ${env.op.kind} -> ${failed ? `error: ${String(failed).slice(0, 120)}` : "ok"}`,
				);
			}

			// Seal the reply back to the console. The signer was just verified as an
			// admitted console, so the box key resolves; a failure here is unexpected and
			// settles the request with a cleartext error rather than stranding it.
			let reply: ConsoleRelayReply;
			try {
				const sealed = sealer.seal(frame.signerSignPub, body);
				// The budget is enforced HERE, at the one point a frame becomes bytes on the shared
				// socket, rather than being a number three constants agree about in a test. An
				// oversized frame does not fail politely: evie's WebSocket closes the gateway
				// connection and every team's traffic goes with it. Refusing this one reply keeps the
				// blast radius at the op that caused it.
				const framed = JSON.stringify(sealed).length;
				if (framed > MAX_RELAY_FRAME_BYTES) {
					throw new Error(`reply frame of ${framed} bytes exceeds ${MAX_RELAY_FRAME_BYTES}`);
				}
				reply = {
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					sealed,
				};
			} catch (err) {
				const message = (err as Error).message;
				console.error(`[console] seal failed for opId ${frame.opId.slice(0, 8)}: ${message}`);
				reply = {
					type: "console_relay_reply",
					v: CONSOLE_PROTOCOL_VERSION,
					opId: frame.opId,
					error: `seal failed: ${message}`,
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
