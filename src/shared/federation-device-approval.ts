import { z } from "zod";
import { b64Field, displayField, SealedEnvelopeSchema } from "./crypto.js";

////////////////////////////////
//  Device self-enroll approval (the "Add a device" rendezvous)
//
//  The owner authorizes their OWN new device, no admin. A held device H (an admitted,
//  authenticated console) ARMs a one-time window; the fresh device N (no creds) JOINs over
//  the Router's public nonce-gated ingress with its generated console keys; H POLLs, shows N's
//  fingerprint, and on a human Approve owner-signs a kind:console admission AND seals the
//  console transport to N's box key, parking it via `approve`; N FETCHes the sealed reply
//  (nonce-gated) and provisions. The Router is the DUMB BROKER keyed by `approvalId`: it relays the
//  join then the sealed reply, reading neither. The QR carries only PUBLIC material (owner
//  keys + domainId + approvalId + nonce + reach); the SA token reaches N only sealed.

////////////////////////////////
//  Schemas

/** N's fresh console keys as H sees them on a poll: the new device's signing + box publics
 * and an optional human device label. H derives the fingerprint it shows from newSignPub. */
const ConsoleApprovalJoinSchema = z
	.object({
		newSignPub: b64Field(),
		newBoxPub: b64Field(),
		joinSig: b64Field().optional(),
		device: displayField(64).optional(),
	})
	.meta({ id: "ConsoleApprovalJoin" });

/** A device-approval frame to the Router's broker, by step. `arm`/`poll`/`approve`/`cancel` come from
 * the AUTHENTICATED held device H (keyed by `approvalId`); `join`/`fetch` come from the fresh
 * device N over the public nonce-gated ingress (`nonce` is the gate). `approve` parks the sealed
 * transport reply; `fetch` retrieves it once H approved. */
export const ConsoleApprovalOpSchema = z
	.discriminatedUnion("step", [
		z.object({ step: z.literal("arm"), approvalId: b64Field(), nonce: b64Field() }),
		z.object({
			step: z.literal("join"),
			approvalId: b64Field(),
			nonce: b64Field(),
			newSignPub: b64Field(),
			newBoxPub: b64Field(),
			joinSig: b64Field().optional(),
			device: displayField(64).optional(),
		}),
		z.object({ step: z.literal("poll"), approvalId: b64Field() }),
		z.object({ step: z.literal("approve"), approvalId: b64Field(), sealed: SealedEnvelopeSchema }),
		z.object({ step: z.literal("fetch"), approvalId: b64Field(), nonce: b64Field() }),
		z.object({ step: z.literal("cancel"), approvalId: b64Field() }),
	])
	.meta({ id: "ConsoleApprovalOp" });

/** The Router's reply to a device-approval frame. `ok:false` + `error` is terminal (window expired, a
 * cap hit, or a nonce/identity mismatch). `join` is present on a `poll` once N has joined; `sealed`
 * is present on a `fetch` once H approved (N unseals the transport with its box key). */
export const ConsoleApprovalResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		join: ConsoleApprovalJoinSchema.optional(),
		sealed: SealedEnvelopeSchema.optional(),
	})
	.meta({ id: "ConsoleApprovalResult" });

export type ConsoleApprovalOp = z.infer<typeof ConsoleApprovalOpSchema>;
export type ConsoleApprovalResult = z.infer<typeof ConsoleApprovalResultSchema>;

export function deviceJoinSigningBytes(
	approvalId: string,
	nonce: string,
	newSignPub: string,
	newBoxPub: string,
): Buffer {
	return Buffer.from(["DEVICE_JOIN_V1", approvalId, nonce, newSignPub, newBoxPub].join("\n"), "utf8");
}
