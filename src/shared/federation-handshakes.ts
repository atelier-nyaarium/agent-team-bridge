import { z } from "zod";
import { b64Field, slugField } from "./crypto.js";

////////////////////////////////
//  Enroll handshake (the FLOW-1 in-person mutual 6-digit compare)
//
//  A fresh enrollee has no gateway, so the commit-reveal that confirms the admin's + the
//  enrollee's OWNER keys is brokered by evie as an UNTRUSTED DUMB BROKER: evie relays the two
//  phones' commit then reveal frames by handshakeId and NEVER computes the SAS (the phones
//  compute it locally - SasCrypto.enrollSas - and the humans compare). These frames carry NO
//  pin (it rides the QR out of band) and NO signature (only the resulting cross-Domain link
//  edge is owner-signed). Each role slot is bound to its first committer; a second, different
//  commitment for the same (handshakeId, role) is rejected (anti-hijack). The phone POSTs the
//  frame DIRECTLY to evie's console-bridge enrollHandshake intake (pre-admission, app-token
//  gated), re-POSTing the same step to poll for the peer's frame.

////////////////////////////////
//  Schemas

/** One revealed enroll party on the wire: the owner keys + Domain + the round-1 salt. The peer
 * re-hashes these (ENROLL_COMMIT_V1) against the round-1 commitment, then folds them into its
 * local enroll SAS. */
export const EnrollRevealSchema = z
	.object({
		ownerSignPub: b64Field(),
		ownerBoxPub: b64Field(),
		domainId: slugField(),
		salt: b64Field(),
	})
	.meta({ id: "EnrollReveal" });

/** A phone's frame to evie's enroll-handshake broker, by step: `commit` (round-1 hiding
 * commitment to this side's owner keys), `reveal` (round-2 owner keys + salt, sent once the
 * peer's commitment is in), `cancel` (abort + evict on [No] / timeout). `handshakeId`
 * (unguessable, from the QR) names the window; `role` is ADMIN (showed the QR) or ENROLLEE
 * (scanned). NO pin (out of band), NO signature (the trust artifact is the later link edge). */
export const EnrollHandshakeOpSchema = z
	.discriminatedUnion("step", [
		z.object({
			step: z.literal("commit"),
			handshakeId: b64Field(),
			role: z.enum(["ADMIN", "ENROLLEE"]),
			commitment: b64Field(),
		}),
		z.object({
			step: z.literal("reveal"),
			handshakeId: b64Field(),
			role: z.enum(["ADMIN", "ENROLLEE"]),
			reveal: EnrollRevealSchema,
		}),
		z.object({ step: z.literal("cancel"), handshakeId: b64Field(), role: z.enum(["ADMIN", "ENROLLEE"]) }),
	])
	.meta({ id: "EnrollHandshakeOp" });

/** evie's reply to an enroll-handshake frame. `ok:false` + `error` is terminal (the window
 * expired, hit the attempt cap, or a role-slot conflict). Otherwise the PEER's frame is
 * included once it lands so the phone can verify + compute the SAS locally; absent means keep
 * polling (re-POST the same step). */
export const EnrollHandshakeResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		// Present on a commit reply once the PEER has committed (round 1 done on both sides).
		peerCommitment: b64Field().optional(),
		// Present on a reveal reply once the PEER has revealed (round 2 done on both sides).
		peerReveal: EnrollRevealSchema.optional(),
	})
	.meta({ id: "EnrollHandshakeResult" });

////////////////////////////////
//  Trust rendezvous (FLOW-2: roster-initiated user-to-user trust)
//
//  Two members already on this evie establish owner-to-owner trust WITHOUT a QR. The initiator ARMS
//  (commits; the rendezvous is indexed at evie under the TARGET owner key). The target discovers the
//  armed intent with a "who armed trust toward me?" query (the highlight - no push), arms back, then
//  both run the SAME commit-reveal owner-key compare as the enroll ceremony, REUSING enrollSas with
//  sorted-owner-key roles + the rendezvousId as the pin (so no new SAS scheme). evie stays the dumb
//  broker: it indexes the two owner keys + relays opaque commit/reveal, never computing the SAS.

export const TrustHandshakeOpSchema = z
	.discriminatedUnion("step", [
		// The INITIATOR arms: creates the rendezvous (indexed under targetOwnerSignPub) + commits.
		z.object({
			step: z.literal("arm"),
			rendezvousId: b64Field(),
			initiatorOwnerSignPub: b64Field(),
			targetOwnerSignPub: b64Field(),
			commitment: b64Field(),
		}),
		// The TARGET arms back (or either side re-polls by re-sending its own commit): joins the
		// rendezvous. The joiner's OWN owner key must match the armed target.
		z.object({
			step: z.literal("join"),
			rendezvousId: b64Field(),
			joinerOwnerSignPub: b64Field(),
			commitment: b64Field(),
		}),
		z.object({
			step: z.literal("reveal"),
			rendezvousId: b64Field(),
			side: z.enum(["INITIATOR", "TARGET"]),
			reveal: EnrollRevealSchema,
		}),
		z.object({ step: z.literal("cancel"), rendezvousId: b64Field() }),
	])
	.meta({ id: "TrustHandshakeOp" });

/** evie's reply to a trust-handshake frame. Same shape + semantics as the enroll-handshake reply:
 * `ok:false` is terminal; otherwise the peer's commit/reveal is included once it lands. */
export const TrustHandshakeResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		peerCommitment: b64Field().optional(),
		peerReveal: EnrollRevealSchema.optional(),
	})
	.meta({ id: "TrustHandshakeResult" });

export type EnrollReveal = z.infer<typeof EnrollRevealSchema>;
export type EnrollHandshakeOp = z.infer<typeof EnrollHandshakeOpSchema>;
export type EnrollHandshakeResult = z.infer<typeof EnrollHandshakeResultSchema>;
export type TrustHandshakeOp = z.infer<typeof TrustHandshakeOpSchema>;
export type TrustHandshakeResult = z.infer<typeof TrustHandshakeResultSchema>;
