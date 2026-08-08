// SYNC-HASH: 3b2e9ff815f7decc90596aa4c688393c
// SYNCED MODULE - source of truth: switchboard/src/shared/federation-enrollment.ts
// Copied verbatim into: evie-bot/app/features/bridge/federation-enrollment.ts
// MUST re-copy on change: cp src/shared/federation-enrollment.ts ../evie-bot/app/features/bridge/federation-enrollment.ts
import { z } from "zod";
import { type Admission, type SignedAdmission, signAdmission } from "./admission.js";
import { fingerprint } from "./crypto.js";

////////////////////////////////
//  Enrollment payloads (the unified QR) + the SAS confirm
//
//  One Android scanner decodes a TYPE-tagged payload and routes by type. Three
//  flows, each anti-MITM via a short-authentication-string (SAS): the same key
//  fingerprint is shown on the scanner AND out-of-band (the gateway's console /
//  the evie admin terminal), and the human confirms they match - a relayed or
//  screenshotted QR cannot forge the out-of-band side.
//
//  - enroll-owner: evie admin command -> owner console. Roots the owner device at
//    the Domain; the owner confirms evie's signing fingerprint from the terminal.
//  - admit-gateway: a gateway -> owner console. The owner confirms the Gateway
//    fingerprint on the gateway console, then signs an admission for it.
//  - authorize-console: owner console -> a second owner device.

////////////////////////////////
//  Schemas

const ServiceBundleSchema = z.object({
	// Reach-evie basics + service keys the wizard delivers (never hand-pasted).
	evieAddr: z.string().optional(),
	transportToken: z.string().optional(),
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
			type: z.literal("admit-gateway"),
			gatewayId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
			// Where the Console delivers the sealed bootstrap bundle. Present when the Gateway opened a
			// LAN listener; absent when the admin chose manual paste. certFp pins that listener's
			// ephemeral self-signed TLS leaf (SHA-256 of the DER, hex): the Console delivers over pinned
			// HTTPS when it is present, and falls back to paste when it is absent, so no cleartext POST.
			lan: z
				.object({
					host: z.string().min(1),
					port: z.number().int().positive(),
					certFp: z.string().min(1).optional(),
				})
				.optional(),
			// One-time nonce gating that listener; the Console echoes it inside the sealed
			// bundle so a stale or cross-window delivery is rejected.
			nonce: z.string().min(1).optional(),
		}),
		z.object({
			type: z.literal("authorize-console"),
			domainId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
			// The device-approval rendezvous (the "Add a device" self-enroll). The held device arms a
			// one-time window at evie and prints these beside the owner keys: `reach` is evie's public
			// nonce-gated ingress the new device POSTs its fresh console keys to, under `approvalId`,
			// gated by `nonce`. All public - never an SA token (the transport reaches the new device sealed).
			approvalId: z.string().min(1),
			nonce: z.string().min(1),
			reach: z.string().min(1),
		}),
	])
	.meta({ id: "EnrollmentPayload" });

export type EnrollmentPayload = z.infer<typeof EnrollmentPayloadSchema>;
export type EnrollOwnerPayload = Extract<EnrollmentPayload, { type: "enroll-owner" }>;
export type AdmitGatewayPayload = Extract<EnrollmentPayload, { type: "admit-gateway" }>;
export type AuthorizeConsolePayload = Extract<EnrollmentPayload, { type: "authorize-console" }>;

////////////////////////////////
//  Functions & Helpers

/** The short authentication string for a scanned payload: the fingerprint of the
 * signing key the human confirms out-of-band before trusting the scan. */
export function payloadSas(payload: EnrollmentPayload): string {
	switch (payload.type) {
		case "enroll-owner":
			return fingerprint(payload.evieSignPub);
		case "admit-gateway":
		case "authorize-console":
			return fingerprint(payload.signPub);
	}
}

/** Build the owner-signed admission for a scanned admit-gateway / authorize-console
 * payload, AFTER the human has confirmed the SAS. `nowMs` + `nonce` are passed in
 * (the caller owns time + randomness). */
export function admissionFromScan(
	payload: AdmitGatewayPayload | AuthorizeConsolePayload,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
	nowMs: number,
	nonceB64: string,
): SignedAdmission {
	const admission: Admission =
		payload.type === "admit-gateway"
			? {
					kind: "gateway",
					signPub: payload.signPub,
					boxPub: payload.boxPub,
					gatewayId: payload.gatewayId,
					issuedAt: nowMs,
					nonce: nonceB64,
				}
			: { kind: "console", signPub: payload.signPub, boxPub: payload.boxPub, issuedAt: nowMs, nonce: nonceB64 };
	return signAdmission(admission, ownerSignPrivB64, ownerSignPubB64);
}
