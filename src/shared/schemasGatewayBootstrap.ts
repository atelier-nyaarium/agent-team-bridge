import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";
import { SealedEnvelopeSchema } from "./schemasConsoleOp.js";
import { GatewayTransportSchema } from "./schemasGatewayTransport.js";

////////////////////////////////
//  Gateway bootstrap bundle (Console -> creds-less Gateway, LAN/paste delivered)
//
//  The owner Console mints this for a Gateway it just admitted and seals it to the
//  Gateway's box key (so plain-HTTP LAN delivery or a pasted blob stays confidential
//  and tamper-evident). It never crosses evie: the Console carries it to the Gateway
//  directly. `transport` is the same SA-token-over-service-proxy shape the Console
//  uses, so one credential mechanism serves both member kinds. `admission` is this
//  Gateway's own owner-signed admission; `domain` mirrors the keyring so the Gateway
//  can verify peers from its first boot.

export const GatewayBootstrapBundleSchema = z
	.object({
		// Echoes the one-time nonce from the admit-gateway QR; the Gateway installs the
		// bundle only if it matches the listener it opened, so a bundle cannot be
		// replayed into a later enrollment window.
		nonce: z.string().min(1),
		transport: GatewayTransportSchema,
		admission: SignedAdmissionSchema,
		domain: DomainSnapshotSchema,
		// the network this gateway joins; the gateway records it so it resolves the same Domain on its next boot
		domainId: z.string().min(1).max(64).optional(),
	})
	.meta({ id: "GatewayBootstrapBundle" });

export type GatewayBootstrapBundle = z.infer<typeof GatewayBootstrapBundleSchema>;

////////////////////////////////
//  Gateway bootstrap delivery frame (the sealed wrapper on the wire)
//
//  What the Console POSTs to the Gateway's LAN listener (or hands over as paste). The
//  Gateway verifies the seal against `signerSignPub`, opens it with its box key, then
//  pins the owner key from the enclosed snapshot. Trust-on-first-use gated by the SAS
//  the human confirmed, the one-time nonce, and LAN proximity.

export const GatewayBootstrapFrameSchema = z
	.object({
		v: z.number().int().positive(),
		signerSignPub: z.string().min(1),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "GatewayBootstrapFrame" });
