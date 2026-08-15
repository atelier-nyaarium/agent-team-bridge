import { z } from "zod";
import { b64Field, slugField } from "./crypto.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";

////////////////////////////////
//  Provisioning Schema
//
//  The blob the user pastes at console setup. Credentials and endpoints only.
//  Runtime defaulting stays app-side (device from Build.MODEL, conversationId
//  minting a UUID, URL normalization); the schema carries only the shape.

// The pending-Domain discriminator carried inside a provisioning blob. Present iff the blob is
// for a pending (unrooted) Domain, both a friend invite and the admin's own fresh setup. A
// pending Domain has no gateway, so the app cannot learn it is pending from a register reply;
// it reads this off the blob and first-roots directly against evie with the nonce. Absent for a
// re-provision of an already-rooted Domain. Named (.meta id) so the codegen emits a nested class.
export const PendingTenantRefSchema = z
	.object({
		// The opaque pending Domain id the friend's first_root roots.
		domainId: slugField(),
		// The one-time invite nonce (base64) evie checks unspent before rooting.
		nonce: b64Field(),
	})
	.meta({ id: "PendingTenantRef" });

// The admin-enroll handshake seed the QR carries (present only on an ADMIN-ENROLL invite
// blob). Named (.meta id) so the codegen emits it as a nested Kotlin class.
export const EnrollHandshakeRefSchema = z
	.object({
		// The admin's OWNER keys + Domain, OOB-authenticated by the in-person scan; the friend
		// folds them into its local enroll SAS (ENROLL_SAS_V1).
		adminOwnerSignPub: b64Field(),
		adminOwnerBoxPub: b64Field(),
		adminDomainId: slugField(),
		// The unguessable id naming the evie broker window both phones drive.
		handshakeId: b64Field(),
		// The one-time shared secret both phones fold into the SAS but NEVER send to evie.
		pin: b64Field(),
	})
	.meta({ id: "EnrollHandshakeRef" });

export const ProvisioningSchema = z
	.object({
		// Which endpoint the fields below describe. Absent reads as "k8s", so a blob written
		// before the Router existed keeps its meaning and its port keeps the proxy sense.
		// A flat discriminant rather than a zod union: this blob is DECODED by the phone, and
		// the Kotlin codegen only emits sealed classes for encode-side roots.
		transport: z.enum(["k8s", "direct"]).optional(),
		// The k8s branch. Optional at the type level so a direct-only blob is representable;
		// the refinement below is what actually requires them.
		apiUrl: z.string().min(1).optional(),
		caPem: z.string().optional(),
		saToken: z.string().optional(),
		// The direct branch: the Router's own endpoint and the leaf fingerprint pinned against it.
		routerUrl: z.string().min(1).optional(),
		routerCertFp: z.string().min(1).optional(),
		appToken: z.string().optional(),
		namespace: z.string().optional(),
		service: z.string().optional(),
		port: z.number().int().positive().optional(),
		device: z.string().optional(),
		conversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN).optional(),
		// Set only for a pending (unrooted) Domain blob (a friend invite or the admin's own fresh
		// setup): the pending Domain id plus the one-time invite nonce. Its presence is the
		// discriminator: the app first-roots iff it is present, else it just provisions the
		// console. Absent for a re-provision of an already-rooted Domain.
		pendingTenant: PendingTenantRefSchema.optional(),
		// Present only on an ADMIN-ENROLL invite blob: the seed for the in-person mutual 6-digit
		// compare the friend runs AFTER first-root (see EnrollHandshakeRef). Absent for a plain
		// provision / re-provision.
		enrollHandshake: EnrollHandshakeRefSchema.optional(),
		// evie's public nonce-gated device-approval ingress, the reach a fresh device POSTs its
		// join/fetch to in the "Add a device" self-enroll. A held device stamps it into the
		// authorize-console QR; absent means this network has no public ingress and the Add-a-device
		// entry is shown disabled.
		deviceApprovalReach: z.string().optional(),
	})
	// The branch's own fields are required together. A refinement never reaches the JSON Schema,
	// so Kotlin still sees flat optionals and this stays the one place the pairing is enforced.
	// `.meta()` goes LAST: refine returns a new instance, and the codegen looks the id up by it.
	.refine(
		(value) =>
			value.transport === "direct"
				? !!value.routerUrl && !!value.routerCertFp
				: !!value.apiUrl && value.caPem != null && value.saToken != null,
		{ message: "provisioning is missing the fields its transport requires" },
	)
	.meta({ id: "Provisioning" });
