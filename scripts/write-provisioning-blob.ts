// Assemble + VALIDATE the provisioning blob. It is validated against the SHARED ProvisioningSchema
// before it is handed back, so a producer/schema field drift (a rename here, a missing field there)
// fails LOUDLY at provision time on the host instead of silently on the device after import.
//
// Transport-only in the phone-anchored model: the Console generates its own identity and resolves
// Gateway keys from the synced keyring, so the identity/gateway fields stay unpopulated. The
// gateway-bridge transport creds are pulled from evie on demand by the Console, never bundled here.

import { ProvisioningSchema } from "../src/shared/schemas.js";

////////////////////////////////
//  Interfaces & Types

export interface ProvisioningBlobInput {
	apiUrl: string;
	caPem: string;
	saToken: string;
	appToken: string;
	namespace?: string;
	service?: string;
	port?: number;
	// Set only for a PENDING (unrooted) admin Domain: the admin domainId + the one-time invite nonce.
	// Its presence is the app's discriminator - it first-roots the Domain at the silently-generated
	// owner key, then provisions the console. Omitted for a re-provision of an already-rooted Domain.
	pendingTenant?: { domainId: string; nonce: string };
	// Legacy host-minted-identity fields; the phone-anchored flow omits them (the Console owns its
	// identity + keyring).
	identity?: string;
	gatewayId?: string;
	gatewaySignPub?: string;
	gatewayBoxPub?: string;
}

////////////////////////////////
//  Functions & Helpers

/** Validate the blob to the shared schema (strips unknown keys, throws on any shape mismatch), so
 * the result is exactly the schema's shape. */
export function buildProvisioningBlob(input: ProvisioningBlobInput): ReturnType<typeof ProvisioningSchema.parse> {
	return ProvisioningSchema.parse(input);
}

/** Validate then write the blob (2-space JSON + trailing newline) to `outPath`. */
export async function writeProvisioningBlob(
	input: ProvisioningBlobInput,
	outPath: string,
): Promise<ReturnType<typeof ProvisioningSchema.parse>> {
	const parsed = buildProvisioningBlob(input);
	await Bun.write(outPath, `${JSON.stringify(parsed, null, 2)}\n`);
	return parsed;
}
