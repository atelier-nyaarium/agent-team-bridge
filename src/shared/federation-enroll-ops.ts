import { z } from "zod";
import { SignedAdmissionSchema, SignedRevocationSchema } from "./admission.js";
import {
	SignedDeleteDomainSchema,
	SignedProvisionTenantSchema,
	SignedRemoveTenantSchema,
	SignedSetDisplayNameSchema,
} from "./federation-tenants.js";
import { SignedXDomainLinkEdgeSchema, SignedXDomainLinkRevocationSchema } from "./federation-xdomain-links.js";

////////////////////////////////
//  Schemas

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
		// A rooted owner purges their OWN Domain (app-only users; admins use setup.sh). evie
		// verifies the signer is the rooted owner, then drops the whole slice.
		z.object({ kind: z.literal("delete_domain"), deletion: SignedDeleteDomainSchema }),
	])
	.meta({ id: "EnrollOp" });

/** evie's reply to an enroll op. */
export const EnrollResultSchema = z
	.object({ ok: z.boolean(), error: z.string().optional() })
	.meta({ id: "EnrollResult" });

export type EnrollOp = z.infer<typeof EnrollOpSchema>;
export type EnrollResult = z.infer<typeof EnrollResultSchema>;
