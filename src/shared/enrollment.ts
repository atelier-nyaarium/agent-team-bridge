// SYNC-HASH: 177537b854c8c968ca812a43b65be0d3
// SYNCED MODULE - source of truth: switchboard/src/shared/enrollment.ts
// Copied verbatim into: evie-bot/app/features/bridge/enrollment.ts
// MUST re-copy on change: cp src/shared/enrollment.ts ../evie-bot/app/features/bridge/enrollment.ts
import { z } from "zod";
import { type Admission, type SignedAdmission, signAdmission } from "./admission.js";
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
//  - enroll-owner: evie admin command -> owner phone. Roots the owner device at
//    the Domain; the owner confirms evie's signing fingerprint from the terminal.
//  - admit-host: an arbiter -> owner phone. The owner confirms the Host
//    fingerprint on the arbiter console, then signs an admission for it.
//  - authorize-phone: owner phone -> a second owner device.

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
			type: z.literal("admit-host"),
			hostId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
		z.object({
			type: z.literal("authorize-phone"),
			domainId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
	])
	.meta({ id: "EnrollmentPayload" });

export type EnrollmentPayload = z.infer<typeof EnrollmentPayloadSchema>;
export type EnrollOwnerPayload = Extract<EnrollmentPayload, { type: "enroll-owner" }>;
export type AdmitHostPayload = Extract<EnrollmentPayload, { type: "admit-host" }>;
export type AuthorizePhonePayload = Extract<EnrollmentPayload, { type: "authorize-phone" }>;

////////////////////////////////
//  Functions & Helpers

/** The short authentication string for a scanned payload: the fingerprint of the
 * signing key the human confirms out-of-band before trusting the scan. */
export function payloadSas(payload: EnrollmentPayload): string {
	switch (payload.type) {
		case "enroll-owner":
			return fingerprint(payload.evieSignPub);
		case "admit-host":
		case "authorize-phone":
			return fingerprint(payload.signPub);
	}
}

/** Build the owner-signed admission for a scanned admit-host / authorize-phone
 * payload, AFTER the human has confirmed the SAS. `nowMs` + `nonce` are passed in
 * (the caller owns time + randomness). */
export function admissionFromScan(
	payload: AdmitHostPayload | AuthorizePhonePayload,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
	nowMs: number,
	nonceB64: string,
): SignedAdmission {
	const admission: Admission =
		payload.type === "admit-host"
			? {
					kind: "host",
					signPub: payload.signPub,
					boxPub: payload.boxPub,
					hostId: payload.hostId,
					issuedAt: nowMs,
					nonce: nonceB64,
				}
			: { kind: "phone", signPub: payload.signPub, boxPub: payload.boxPub, issuedAt: nowMs, nonce: nonceB64 };
	return signAdmission(admission, ownerSignPrivB64, ownerSignPubB64);
}
