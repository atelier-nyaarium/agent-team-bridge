// SYNC-HASH: 1630a1d83ca2eae26a704c4ec7caa86f
// SYNCED MODULE - source of truth: switchboard/src/shared/federation-lifecycle.ts
// Copied verbatim into: evie-bot/app/features/bridge/federation-lifecycle.ts
// MUST re-copy on change: cp src/shared/federation-lifecycle.ts ../evie-bot/app/features/bridge/federation-lifecycle.ts
import { z } from "zod";
import {
	type Admission,
	type SignedAdmission,
	SignedAdmissionSchema,
	SignedRevocationSchema,
	signAdmission,
} from "./admission.js";
import { b64Field, displayField, fingerprint, sign, slugField, verify } from "./crypto.js";

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
//  - admit-gateway: an gateway -> owner console. The owner confirms the Gateway
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
			// Where the Console delivers the sealed bootstrap bundle. Present when the
			// Gateway opened a LAN listener; absent when the admin chose manual paste.
			lan: z.object({ host: z.string().min(1), port: z.number().int().positive() }).optional(),
			// One-time nonce gating that listener; the Console echoes it inside the sealed
			// bundle so a stale or cross-window delivery is rejected.
			nonce: z.string().min(1).optional(),
		}),
		z.object({
			type: z.literal("authorize-console"),
			domainId: z.string().min(1),
			signPub: z.string().min(1),
			boxPub: z.string().min(1),
		}),
	])
	.meta({ id: "EnrollmentPayload" });

/** A content-blind cross-Domain link edge: an owner attests that traffic from its
 * Domain (`srcDomainId`) may relay to a friend Domain (`dstDomainId`) it has linked
 * with. evie's relay-affinity gate honors a cross-Domain `gateway_relay` only when such
 * an owner-signed edge exists for the pair. Content-blind: it names only the two Domain
 * ids, never a session or a key. Both ids are slug-constrained so neither can carry a
 * newline that would make the signing bytes ambiguous against the other. */
export const XDomainLinkEdgeSchema = z
	.object({
		srcDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		dstDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		issuedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLinkEdge" });

export const SignedXDomainLinkEdgeSchema = z
	.object({
		edge: XDomainLinkEdgeSchema,
		// The linking owner's root key (base64). evie checks it against the srcDomain's
		// rooted owner key (the owner of the Domain the edge authorizes traffic FROM),
		// never trusting this field alone.
		ownerSignPub: z.string().min(1),
		// The owner's Ed25519 signature over xDomainLinkEdgeSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkEdge" });

/** The owner-signed revocation of a cross-Domain link edge: it withdraws the owner's
 * attestation that traffic from `srcDomainId` may relay to `dstDomainId`. evie drops every
 * matching edge for the pair, so its relay-affinity gate refuses the cross-Domain
 * `gateway_relay` again. Content-blind and slug-constrained like the edge it revokes; the
 * shape adds the admission Revocation's revoke-time/nonce fields. */
export const XDomainLinkRevocationSchema = z
	.object({
		srcDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		dstDomainId: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.max(64),
		revokedAt: z.number().int().nonnegative(),
		nonce: z.string().min(1),
	})
	.meta({ id: "XDomainLinkRevocation" });

export const SignedXDomainLinkRevocationSchema = z
	.object({
		revocation: XDomainLinkRevocationSchema,
		// The revoking owner's root key (base64). evie checks it against the srcDomain's
		// rooted owner key (the owner of the Domain whose edge is being revoked), never
		// trusting this field alone.
		ownerSignPub: z.string().min(1),
		// The owner's Ed25519 signature over xDomainLinkRevocationSigningBytes (base64).
		signature: z.string().min(1),
	})
	.meta({ id: "SignedXDomainLinkRevocation" });

////////////////////////////////
//  Friend cross-Domain onboarding (pending tenant + first-root + display name)
//
//  The admin pre-stages a friend's Domain as a PENDING tenant (a domainId + a
//  displayName label, NO owner root) and mints a one-time invite QR; the friend's app
//  first-roots the Domain at its silently-generated owner key on first connect. The
//  signing artifacts below ride the app-token-gated bridge to evie:
//
//  - provision_tenant / remove_tenant: ADMIN-signed. evie creates / drops the pending tenant.
//  - first_root: SELF-signed by the friend's fresh owner key (no admission exists yet),
//    carrying the one-time QR nonce; evie roots the pending Domain at it, idempotent on the
//    same key, refusing a re-root at a different key.
//  - set_display_name: OWNER-signed; evie CAS-merges the rename and pushes it to the Domain's
//    own gateways, while linked Peers see it on their next discovery refresh.
//
//  Each preimage is the SAME versioned, newline-joined, fixed-order encoding as
//  admissionSigningBytes, and every field is base64, slug, decimal, or a newline-free
//  display string, so no field can carry a newline that makes the encoding ambiguous.
//  `displayName` carries no trust weight under the cooperative threat model (it cannot
//  forge an identity, only re-spell the label). Handlers MUST read each value from the
//  PARSED object, never by re-splitting the preimage. Do NOT sign raw JSON.

/** A pending (rootless) tenant the admin pre-stages: a domainId + an displayName
 * display label, the one-time invite nonce (issuedAt + ttlMs server-checked at evie),
 * and `rooted` flipped true once a friend's first_root spends the nonce. */
export const PendingTenantSchema = z
	.object({
		// The opaque Domain id (slug; never shown to the human - pure plumbing).
		domainId: slugField(),
		// The friendly display name (one per owner/Domain). Free text the admin
		// pre-sets and the friend edits from their profile once in.
		displayName: displayField(128),
		// The one-time invite nonce (base64), spent on the first successful first-root.
		nonce: b64Field(),
		// When the invite was minted (epoch ms); the TTL is measured from this.
		issuedAt: z.number().int().nonnegative(),
		// Invite lifetime (ms); evie sweeps an unredeemed pending tenant at issuedAt + ttlMs.
		ttlMs: z.number().int().nonnegative(),
		// True once a friend's first_root has rooted this Domain; the invite is then spent.
		rooted: z.boolean(),
	})
	.meta({ id: "PendingTenant" });

/** The admin's request to create a pending tenant (admin-signed). The signing bytes
 * bind the admin's own fingerprint, so evie can pin the request to the admin's key. */
export const ProvisionTenantSchema = z
	.object({
		domainId: slugField(),
		displayName: displayField(128),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "ProvisionTenant" });

export const SignedProvisionTenantSchema = z
	.object({
		provision: ProvisionTenantSchema,
		// The admin's root signing public key (base64). evie checks it against the
		// admin's known key, never trusting this field alone; the signing bytes carry
		// its fingerprint.
		adminSignPub: b64Field(),
		// The admin's Ed25519 signature over provisionTenantSigningBytes (base64).
		signature: b64Field(),
	})
	.meta({ id: "SignedProvisionTenant" });

/** The admin's request to drop a pending tenant (admin-signed). */
export const RemoveTenantSchema = z
	.object({
		domainId: slugField(),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "RemoveTenant" });

export const SignedRemoveTenantSchema = z
	.object({
		removal: RemoveTenantSchema,
		adminSignPub: b64Field(),
		signature: b64Field(),
	})
	.meta({ id: "SignedRemoveTenant" });

/** The friend console's first-root of a pending Domain (SELF-signed by the fresh owner
 * key). No admission exists yet, so the verifier checks the signature against the frame's
 * OWN ownerSignPub; the one-time QR `nonce` (server-checked unspent at evie) is the
 * authorization, the self-signature only proves possession of the submitted owner key. */
export const FirstRootSchema = z
	.object({
		domainId: slugField(),
		// The friend's silently-generated owner root keys (base64) the Domain roots at.
		ownerSignPub: b64Field(),
		ownerBoxPub: b64Field(),
		// The one-time invite nonce from the QR (base64); evie roots only if it is unspent.
		nonce: b64Field(),
		issuedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "FirstRoot" });

export const SignedFirstRootSchema = z
	.object({
		firstRoot: FirstRootSchema,
		// The owner's self-signature over firstRootSigningBytes (base64), verified against
		// firstRoot.ownerSignPub (the key being rooted). No separate ownerSignPub field: the
		// signer IS the subject, so the key lives inside `firstRoot`.
		signature: b64Field(),
	})
	.meta({ id: "SignedFirstRoot" });

/** The owner's request to rename their Domain's display name (owner-signed). evie CAS-merges
 * it and pushes a domain_update to the Domain's OWN gateways, so the rename is immediate there;
 * linked Peers pick it up lazily on their next discovery refresh. */
export const SetDisplayNameSchema = z
	.object({
		domainId: slugField(),
		displayName: displayField(128),
		issuedAt: z.number().int().nonnegative(),
		nonce: b64Field(),
	})
	.meta({ id: "SetDisplayName" });

export const SignedSetDisplayNameSchema = z
	.object({
		rename: SetDisplayNameSchema,
		// The rooted owner's root signing public key (base64). evie checks it against the
		// Domain's rooted owner key, never trusting this field alone; the signing bytes carry
		// its fingerprint.
		ownerSignPub: b64Field(),
		// The owner's Ed25519 signature over setDisplayNameSigningBytes (base64).
		signature: b64Field(),
	})
	.meta({ id: "SignedSetDisplayName" });

/** The owner device's enrollment requests to evie (NOT relayed to a Gateway - evie
 * is the Domain root). All are self-authenticating: `enroll_redeem` is authorized by
 * the single-use nonce evie minted, and the submit ops carry an owner-signed artifact
 * evie verifies against the rooted owner key. The console sends them over the same
 * app-token-gated bridge as its gateway ops. */
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
		z.object({ kind: z.literal("submit_xdomain_link"), edge: SignedXDomainLinkEdgeSchema }),
		z.object({ kind: z.literal("revoke_xdomain_link"), revocation: SignedXDomainLinkRevocationSchema }),
		// Friend cross-Domain onboarding: the admin stages (provision_tenant) or drops
		// (remove_tenant) a pending tenant, and the rooted owner renames it (set_display_name).
		// first_root is NOT on this surface: a pending Domain has no gateway, so the friend's app
		// POSTs the SignedFirstRoot DIRECTLY to evie's console-bridge firstRoot intake (no
		// admission exists yet pre-root; the one-time invite nonce is its authorization).
		z.object({ kind: z.literal("provision_tenant"), provision: SignedProvisionTenantSchema }),
		z.object({ kind: z.literal("remove_tenant"), removal: SignedRemoveTenantSchema }),
		z.object({ kind: z.literal("set_display_name"), rename: SignedSetDisplayNameSchema }),
	])
	.meta({ id: "EnrollOp" });

/** evie's reply to an enroll op. */
export const EnrollResultSchema = z
	.object({ ok: z.boolean(), error: z.string().optional() })
	.meta({ id: "EnrollResult" });

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
//  Cross-tenant roster (the "Users" surface: everyone on this evie, name + presence)
//
//  evie is the source of truth (per-Domain display names + owners in its Secret; presence is its
//  live gateway-connection table). The visibility model is a full roster: every member on this evie
//  is visible to every other member, non-transitive (the roster never reaches a member's linked
//  peers). So the request only AUTHENTICATES the caller as some member of this evie (a console
//  admitted in one of its Domains); there is no per-row visibility predicate. A row carries the
//  owner identity + display name + presence ONLY: NO gatewayId and NO box key, so a row is never a
//  seal/probe handle (the trust ceremony resolves a target's gateway server-side). evie
//  OPAQUE-REJECTS a caller it cannot place in a Domain.

/** A console's signed request for the roster. The console signs ROSTER_V1 over its own signing key
 * + a fresh timestamp + nonce (proof of possession); evie verifies the signature, freshness, and
 * non-replay, then resolves the signer to an admitted console in one of its Domains. */
export const RosterRequestSchema = z
	.object({
		// The console's raw Ed25519 signing key (the subject of an owner-signed kind:console admission).
		signerSignPub: b64Field(),
		// Proof timestamp (epoch ms), freshness-checked against evie's clock.
		proofAt: z.number().int().nonnegative(),
		// Single-use random (base64); evie rejects a replayed nonce within the freshness window.
		nonce: b64Field(),
		// The console's Ed25519 signature over rosterRequestSigningBytes (base64).
		proof: b64Field(),
	})
	.meta({ id: "RosterRequest" });

/** One member row in the roster: the owner identity (the trust anchor; the phone derives the
 * fingerprint from it), the display name, and a presence boolean. Deliberately NO gatewayId
 * / box key / domainId - a row is an identity, never a routing or seal handle, and topology is
 * stripped. */
export const RosterMemberSchema = z
	.object({
		ownerSignPub: b64Field(),
		displayName: displayField(128),
		// True iff this member's Domain has a live gateway connection at evie right now.
		online: z.boolean(),
	})
	.meta({ id: "RosterMember" });

/** evie's roster reply. `ok:false` + `error` is an OPAQUE reject (the caller could not be placed in a
 * Domain on this evie, or the proof failed) - it never enumerates Domain state. */
export const RosterResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		// Present only on success; absent on an opaque reject.
		members: z.array(RosterMemberSchema).optional(),
	})
	.meta({ id: "RosterResult" });

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

/** A target's signed "who armed trust toward me?" query (the highlight). The target signs
 * TRUST_PENDING_V1 over its OWN owner signing key + a fresh timestamp + nonce (proof of possession);
 * evie verifies the signature, freshness, and non-replay, then returns the arms indexed under that
 * owner key. Only the owner-key holder can enumerate the arms aimed at it. */
export const TrustPendingRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TrustPendingRequest" });

/** One armed trust intent toward the querying owner: who armed it + the rendezvous to join. */
export const TrustPendingEntrySchema = z
	.object({
		initiatorOwnerSignPub: b64Field(),
		rendezvousId: b64Field(),
	})
	.meta({ id: "TrustPendingEntry" });

export const TrustPendingResultSchema = z
	.object({
		ok: z.boolean(),
		error: z.string().optional(),
		// Present only on success; absent on an opaque reject.
		pending: z.array(TrustPendingEntrySchema).optional(),
	})
	.meta({ id: "TrustPendingResult" });

////////////////////////////////
//  Transport request (an owner pulling its network's gateway-bridge transport)
//
//  An owner phone asks evie for the gateway-bridge transport blob (the cluster SA token + CA)
//  by proving it owns a rooted network. It signs TRANSPORT_REQUEST_V1 over its OWN owner signing
//  key + a fresh timestamp + nonce (proof of possession), mirroring the roster / trust-pending
//  proofs. evie verifies the signature, freshness, and non-replay, then resolves the signer to a
//  rooted owner and returns the transport.

/** An owner's signed request for its network's gateway-bridge transport. */
export const TransportRequestSchema = z
	.object({
		signerSignPub: b64Field(),
		proofAt: z.number().int().nonnegative(),
		nonce: b64Field(),
		proof: b64Field(),
	})
	.meta({ id: "TransportRequest" });

/** evie's transport reply. `ok:false` + `error` is an OPAQUE reject (the proof failed or the signer
 * is not a rooted owner). On success it carries the gateway-bridge transport creds. */
export const TransportResultSchema = z
	.object({
		ok: z.boolean(),
		saToken: z.string().optional(),
		caPem: z.string().optional(),
		error: z.string().optional(),
	})
	.meta({ id: "TransportResult" });

export type EnrollmentPayload = z.infer<typeof EnrollmentPayloadSchema>;
export type EnrollOwnerPayload = Extract<EnrollmentPayload, { type: "enroll-owner" }>;
export type AdmitGatewayPayload = Extract<EnrollmentPayload, { type: "admit-gateway" }>;
export type AuthorizeConsolePayload = Extract<EnrollmentPayload, { type: "authorize-console" }>;
export type EnrollOp = z.infer<typeof EnrollOpSchema>;
export type EnrollResult = z.infer<typeof EnrollResultSchema>;
export type EnrollReveal = z.infer<typeof EnrollRevealSchema>;
export type EnrollHandshakeOp = z.infer<typeof EnrollHandshakeOpSchema>;
export type EnrollHandshakeResult = z.infer<typeof EnrollHandshakeResultSchema>;
export type PendingTenant = z.infer<typeof PendingTenantSchema>;
export type ProvisionTenant = z.infer<typeof ProvisionTenantSchema>;
export type SignedProvisionTenant = z.infer<typeof SignedProvisionTenantSchema>;
export type RemoveTenant = z.infer<typeof RemoveTenantSchema>;
export type SignedRemoveTenant = z.infer<typeof SignedRemoveTenantSchema>;
export type FirstRoot = z.infer<typeof FirstRootSchema>;
export type SignedFirstRoot = z.infer<typeof SignedFirstRootSchema>;
export type SetDisplayName = z.infer<typeof SetDisplayNameSchema>;
export type SignedSetDisplayName = z.infer<typeof SignedSetDisplayNameSchema>;
export type XDomainLinkEdge = z.infer<typeof XDomainLinkEdgeSchema>;
export type SignedXDomainLinkEdge = z.infer<typeof SignedXDomainLinkEdgeSchema>;
export type XDomainLinkRevocation = z.infer<typeof XDomainLinkRevocationSchema>;
export type SignedXDomainLinkRevocation = z.infer<typeof SignedXDomainLinkRevocationSchema>;
export type RosterRequest = z.infer<typeof RosterRequestSchema>;
export type RosterMember = z.infer<typeof RosterMemberSchema>;
export type RosterResult = z.infer<typeof RosterResultSchema>;
export type TrustHandshakeOp = z.infer<typeof TrustHandshakeOpSchema>;
export type TrustHandshakeResult = z.infer<typeof TrustHandshakeResultSchema>;
export type TrustPendingRequest = z.infer<typeof TrustPendingRequestSchema>;
export type TrustPendingEntry = z.infer<typeof TrustPendingEntrySchema>;
export type TrustPendingResult = z.infer<typeof TrustPendingResultSchema>;
export type TransportRequest = z.infer<typeof TransportRequestSchema>;
export type TransportResult = z.infer<typeof TransportResultSchema>;

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

/** Versioned, newline-joined signing bytes for a cross-Domain link edge. Mirrors
 * `admissionSigningBytes` in shape; every field is base64 or a slug, so the encoding is
 * unambiguous and reproduces byte-for-byte on switchboard, evie, and Android. Do NOT
 * sign raw JSON. */
export function xDomainLinkEdgeSigningBytes(edge: XDomainLinkEdge, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"XDOMAIN_RELAY_GATE_V1",
			ownerSignPubB64,
			edge.srcDomainId,
			edge.dstDomainId,
			String(edge.issuedAt),
			edge.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Owner-sign a cross-Domain link edge (the owner device holds the signing key). */
export function signXDomainLinkEdge(
	edge: XDomainLinkEdge,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLinkEdge {
	return {
		edge,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkEdgeSigningBytes(edge, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the link edge verifies under the EXPECTED owner key (the rooted owner of the
 * edge's srcDomain). The claimed ownerSignPub must equal the expected key AND the
 * signature must check. */
export function verifyXDomainLinkEdge(s: SignedXDomainLinkEdge, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(xDomainLinkEdgeSigningBytes(s.edge, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

/** Versioned, newline-joined signing bytes for a cross-Domain link-edge revocation.
 * The prefix is distinct from the link edge's, so a captured edge signature can never be
 * replayed as a revocation (or the reverse). Every field is base64 or a slug, so the
 * encoding is unambiguous and reproduces byte-for-byte on switchboard, evie, and Android.
 * Do NOT sign raw JSON. */
export function xDomainLinkRevocationSigningBytes(rev: XDomainLinkRevocation, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		["XDOMAIN_REVOKE_V1", ownerSignPubB64, rev.srcDomainId, rev.dstDomainId, String(rev.revokedAt), rev.nonce].join(
			"\n",
		),
		"utf8",
	);
}

/** Owner-sign a cross-Domain link-edge revocation (the owner device holds the signing key). */
export function signXDomainLinkRevocation(
	rev: XDomainLinkRevocation,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedXDomainLinkRevocation {
	return {
		revocation: rev,
		ownerSignPub: ownerSignPubB64,
		signature: sign(xDomainLinkRevocationSigningBytes(rev, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the revocation verifies under the EXPECTED owner key (the rooted owner of the
 * revocation's srcDomain). The claimed ownerSignPub must equal the expected key AND the
 * signature must check. */
export function verifyXDomainLinkRevocation(s: SignedXDomainLinkRevocation, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(
		xDomainLinkRevocationSigningBytes(s.revocation, expectedOwnerSignPubB64),
		s.signature,
		expectedOwnerSignPubB64,
	);
}

////////////////////////////////
//  Friend onboarding signing bytes (provision / remove / first-root / set-name)
//
//  Each mirrors `admissionSigningBytes` in shape: a versioned, newline-joined,
//  fixed-order encoding. The signer's identity is bound by `fingerprint(signerSignPub)`
//  (grouped uppercase hex, newline-free); the full signing key rides the SIGNED wrapper
//  so the verifier can recompute the fingerprint AND check the signature. Distinct
//  version prefixes keep the four artifacts non-interchangeable (a captured signature for
//  one can never replay as another). Do NOT sign raw JSON.

/** PROVISION_TENANT_V1 signing bytes (admin-signed; NO ownerSignPub - the tenant is
 * pending / rootless). `adminFingerprint` is the fingerprint of the admin key in
 * the signed wrapper. */
export function provisionTenantSigningBytes(p: ProvisionTenant, adminSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"PROVISION_TENANT_V1",
			fingerprint(adminSignPubB64),
			p.domainId,
			p.displayName,
			String(p.issuedAt),
			p.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Admin-sign a pending-tenant provision. */
export function signProvisionTenant(
	provision: ProvisionTenant,
	adminSignPrivB64: string,
	adminSignPubB64: string,
): SignedProvisionTenant {
	return {
		provision,
		adminSignPub: adminSignPubB64,
		signature: sign(provisionTenantSigningBytes(provision, adminSignPubB64), adminSignPrivB64),
	};
}

/** True if the provision verifies under the EXPECTED admin key. The claimed
 * adminSignPub must equal the expected key AND the signature must check. */
export function verifyProvisionTenant(s: SignedProvisionTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(
		provisionTenantSigningBytes(s.provision, expectedAdminSignPubB64),
		s.signature,
		expectedAdminSignPubB64,
	);
}

/** REMOVE_TENANT_V1 signing bytes (admin-signed). */
export function removeTenantSigningBytes(r: RemoveTenant, adminSignPubB64: string): Buffer {
	return Buffer.from(
		["REMOVE_TENANT_V1", fingerprint(adminSignPubB64), r.domainId, String(r.issuedAt), r.nonce].join("\n"),
		"utf8",
	);
}

/** Admin-sign a pending-tenant removal. */
export function signRemoveTenant(
	removal: RemoveTenant,
	adminSignPrivB64: string,
	adminSignPubB64: string,
): SignedRemoveTenant {
	return {
		removal,
		adminSignPub: adminSignPubB64,
		signature: sign(removeTenantSigningBytes(removal, adminSignPubB64), adminSignPrivB64),
	};
}

/** True if the removal verifies under the EXPECTED admin key. */
export function verifyRemoveTenant(s: SignedRemoveTenant, expectedAdminSignPubB64: string): boolean {
	if (s.adminSignPub !== expectedAdminSignPubB64) return false;
	return verify(removeTenantSigningBytes(s.removal, expectedAdminSignPubB64), s.signature, expectedAdminSignPubB64);
}

/** FIRST_ROOT_V1 signing bytes (SELF-signed by the fresh owner key; `ownerSignPub` is the
 * key being rooted, carried INSIDE the artifact, and `nonce` is the one-time QR token). */
export function firstRootSigningBytes(f: FirstRoot): Buffer {
	return Buffer.from(
		["FIRST_ROOT_V1", f.domainId, f.ownerSignPub, f.ownerBoxPub, f.nonce, String(f.issuedAt)].join("\n"),
		"utf8",
	);
}

/** Self-sign a first-root with the fresh owner signing key (the subject IS the signer). */
export function signFirstRoot(firstRoot: FirstRoot, ownerSignPrivB64: string): SignedFirstRoot {
	return { firstRoot, signature: sign(firstRootSigningBytes(firstRoot), ownerSignPrivB64) };
}

/** True if the first-root self-signature checks against the owner key it roots at
 * (firstRoot.ownerSignPub). Proves possession of the submitted owner key; the one-time
 * nonce (checked unspent at evie) is the authorization. */
export function verifyFirstRoot(s: SignedFirstRoot): boolean {
	return verify(firstRootSigningBytes(s.firstRoot), s.signature, s.firstRoot.ownerSignPub);
}

/** SET_DISPLAY_NAME_V1 signing bytes (owner-signed). `ownerFingerprint` is the
 * fingerprint of the rooted owner key in the signed wrapper. */
export function setDisplayNameSigningBytes(r: SetDisplayName, ownerSignPubB64: string): Buffer {
	return Buffer.from(
		[
			"SET_DISPLAY_NAME_V1",
			fingerprint(ownerSignPubB64),
			r.domainId,
			r.displayName,
			String(r.issuedAt),
			r.nonce,
		].join("\n"),
		"utf8",
	);
}

/** Owner-sign an display-name rename (the owner device holds the signing key). */
export function signSetDisplayName(
	rename: SetDisplayName,
	ownerSignPrivB64: string,
	ownerSignPubB64: string,
): SignedSetDisplayName {
	return {
		rename,
		ownerSignPub: ownerSignPubB64,
		signature: sign(setDisplayNameSigningBytes(rename, ownerSignPubB64), ownerSignPrivB64),
	};
}

/** True if the rename verifies under the EXPECTED owner key (the Domain's rooted owner). */
export function verifySetDisplayName(s: SignedSetDisplayName, expectedOwnerSignPubB64: string): boolean {
	if (s.ownerSignPub !== expectedOwnerSignPubB64) return false;
	return verify(setDisplayNameSigningBytes(s.rename, expectedOwnerSignPubB64), s.signature, expectedOwnerSignPubB64);
}

////////////////////////////////
//  Roster request proof-of-possession (a console proving it holds an admitted signing key)
//
//  Mirrors the registration proof: the console signs a versioned, newline-joined challenge over its
//  own signing key + a fresh timestamp + nonce. evie verifies the signature against the key, that
//  the timestamp is fresh, and (statefully) that the nonce is unseen in the window, then resolves
//  the key to an owner-signed kind:console admission in one of its Domains. So a captured request
//  cannot be replayed to pull the roster.

/** Default roster-proof freshness window (epoch ms), same posture as the registration proof. */
export const ROSTER_MAX_SKEW_MS = 120_000;

export function rosterRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["ROSTER_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh roster request with the console's raw Ed25519 private key. */
export function signRosterRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(rosterRequestSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

/** True if the roster request's proof verifies under its claimed signer key. The caller (evie)
 * additionally checks freshness, non-replay, and that the signer is an admitted console. */
export function verifyRosterRequest(req: RosterRequest): boolean {
	return verify(rosterRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

/** Default trust-pending-proof freshness window (epoch ms), same posture as the roster proof. */
export const TRUST_PENDING_MAX_SKEW_MS = 120_000;

/** Canonical TRUST_PENDING_V1 proof-of-possession bytes: the querying OWNER's signing key + a fresh
 * timestamp + nonce. A distinct version tag from ROSTER_V1 so a roster proof can never be replayed as
 * a trust-pending query and vice versa. */
export function trustPendingSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["TRUST_PENDING_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh trust-pending query with the querying owner's raw Ed25519 private key. */
export function signTrustPendingRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signPrivB64: string,
): string {
	return sign(trustPendingSigningBytes(signerSignPubB64, proofAt, nonce), signPrivB64);
}

/** True if the trust-pending query's proof verifies under its claimed owner key. The caller (evie)
 * additionally checks freshness + non-replay before returning the arms indexed under that owner. */
export function verifyTrustPendingRequest(req: TrustPendingRequest): boolean {
	return verify(trustPendingSigningBytes(req.signerSignPub, req.proofAt, req.nonce), req.proof, req.signerSignPub);
}

/** Default transport-proof freshness window (epoch ms), same posture as the roster proof. */
export const TRANSPORT_REQUEST_MAX_SKEW_MS = 120_000;

/** Canonical TRANSPORT_REQUEST_V1 proof-of-possession bytes: the requesting OWNER's signing key + a
 * fresh timestamp + nonce. A distinct version tag from ROSTER_V1 / TRUST_PENDING_V1 so neither proof
 * can be replayed as a transport request and vice versa. */
export function transportRequestSigningBytes(signerSignPubB64: string, proofAt: number, nonce: string): Buffer {
	return Buffer.from(["TRANSPORT_REQUEST_V1", signerSignPubB64, String(proofAt), nonce].join("\n"), "utf8");
}

/** Sign a fresh transport request with the requesting owner's raw Ed25519 private key (private key
 * last, matching signRosterRequest / signTrustPendingRequest and the Kotlin twin). */
export function signTransportRequest(
	signerSignPubB64: string,
	proofAt: number,
	nonce: string,
	signerSignPrivB64: string,
): TransportRequest {
	return {
		signerSignPub: signerSignPubB64,
		proofAt,
		nonce,
		proof: sign(transportRequestSigningBytes(signerSignPubB64, proofAt, nonce), signerSignPrivB64),
	};
}

/** True if the transport request's proof verifies under its claimed owner key. The caller (evie)
 * additionally checks freshness, non-replay, and that the signer is a rooted owner before returning
 * the transport. */
export function verifyTransportRequest(req: TransportRequest): boolean {
	return verify(
		transportRequestSigningBytes(req.signerSignPub, req.proofAt, req.nonce),
		req.proof,
		req.signerSignPub,
	);
}
