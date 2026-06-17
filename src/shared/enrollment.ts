// SYNC-HASH: 10c8ae9687851b0324a30a57369147da
// SYNCED MODULE - source of truth: switchboard/src/shared/enrollment.ts
// Copied verbatim into: evie-bot/app/features/bridge/enrollment.ts
// MUST re-copy on change: cp src/shared/enrollment.ts ../evie-bot/app/features/bridge/enrollment.ts
import { z } from "zod";
import {
	type Admission,
	type SignedAdmission,
	SignedAdmissionSchema,
	SignedRevocationSchema,
	signAdmission,
} from "./admission.js";
import { fingerprint } from "./crypto.js";

////////////////////////////////
//  Enrollment payloads (the unified QR) + the SAS confirm
//
//  One Android scanner decodes a TYPE-tagged payload and routes by type. Three
//  flows, each anti-MITM via a short-authentication-string (SAS): the same key
//  fingerprint is shown on the scanner AND out-of-band (the arbiter's console /
//  the evie admin terminal), and the human confirms they match - a relayed or
//  screenshotted QR cannot forge the out-of-band side.
//
//  - enroll-owner: evie admin command -> owner console. Roots the owner device at
//    the Domain; the owner confirms evie's signing fingerprint from the terminal.
//  - admit-switch: an arbiter -> owner console. The owner confirms the Switch
//    fingerprint on the arbiter console, then signs an admission for it.
//  - authorize-console: owner console -> a second owner device.

////////////////////////////////
//  Schemas

const ServiceBundleSchema = z.object({
	// Reach-evie basics + service keys the wizard delivers (never hand-pasted).
	evieAddr: z.string().optional(),
	transportToken: z.string().optional(),
	sttsUrl: z.string().optional(),
	sttsKey: z.string().optional(),
});

export const EnrollmentPayloadSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("enroll-owner"),
			domainId: z.string().min(1),
			evieAddr: z.string().min(1),
			evieSignPub: z.string().min(1),
			evieBoxPub: z.string().min(1),
			// Single-use, tight-TTL nonce redeemed once at evie (anti-replay R1).
			nonce: z.string().min(1),
			bundle: ServiceBundleSchema.optional(),
		}),
		z.object({
			type: z.literal("admit-switch"),
			switchId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
		z.object({
			type: z.literal("authorize-console"),
			domainId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
	])
	.meta({ id: "EnrollmentPayload" });

/** The owner device's enrollment requests to evie (NOT relayed to a Switch - evie
 * is the Domain root). All three are self-authenticating: `enroll_redeem` is
 * authorized by the single-use nonce evie minted, and the submit ops carry an
 * owner-signed artifact evie verifies against the rooted owner key. The console
 * sends them over the same app-token-gated bridge as its arbiter ops. */
export const EnrollOpSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("enroll_redeem"),
			nonce: z.string().min(1),
			ownerSignPub: z.string().min(1),
			ownerBoxPub: z.string().min(1),
		}),
		z.object({ kind: z.literal("submit_admission"), admission: SignedAdmissionSchema }),
		z.object({ kind: z.literal("submit_revocation"), revocation: SignedRevocationSchema }),
	])
	.meta({ id: "EnrollOp" });

/** evie's reply to an enroll op. */
export const EnrollResultSchema = z
	.object({ ok: z.boolean(), error: z.string().optional() })
	.meta({ id: "EnrollResult" });

export type EnrollmentPayload = z.infer<typeof EnrollmentPayloadSchema>;
export type EnrollOwnerPayload = Extract<EnrollmentPayload, { type: "enroll-owner" }>;
export type AdmitSwitchPayload = Extract<EnrollmentPayload, { type: "admit-switch" }>;
export type AuthorizeConsolePayload = Extract<EnrollmentPayload, { type: "authorize-console" }>;
export type EnrollOp = z.infer<typeof EnrollOpSchema>;
export type EnrollResult = z.infer<typeof EnrollResultSchema>;

////////////////////////////////
//  Functions & Helpers

/** The short authentication string for a scanned payload: the fingerprint of the
 * signing key the human confirms out-of-band before trusting the scan. */
export function payloadSas(payload: EnrollmentPayload): string {
	switch (payload.type) {
		case "enroll-owner":
			return fingerprint(payload.evieSignPub);
		case "admit-switch":
		case "authorize-console":
			return fingerprint(payload.signPub);
	}
}

/** Build the owner-signed admission for a scanned admit-switch / authorize-console
 * payload, AFTER the human has confirmed the SAS. `nowMs` + `nonce` are passed in
 * (the caller owns time + randomness). */
export function admissionFromScan(
	payload: AdmitSwitchPayload | AuthorizeConsolePayload,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
	nowMs: number,
	nonceB64: string,
): SignedAdmission {
	const admission: Admission =
		payload.type === "admit-switch"
			? {
					kind: "switch",
					signPub: payload.signPub,
					boxPub: payload.boxPub,
					switchId: payload.switchId,
					issuedAt: nowMs,
					nonce: nonceB64,
				}
			: { kind: "console", signPub: payload.signPub, boxPub: payload.boxPub, issuedAt: nowMs, nonce: nonceB64 };
	return signAdmission(admission, ownerSignPrivB64, ownerSignPubB64);
}
