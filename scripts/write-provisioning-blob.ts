// Assemble + VALIDATE the provisioning blob. It is validated against the SHARED ProvisioningSchema
// before it is handed back, so a producer/schema field drift (a rename here, a missing field there)
// fails LOUDLY at provision time on the host instead of silently on the device after import.
//
// Transport-only in the phone-anchored model: the Console generates its own identity and resolves
// Gateway keys from the synced keyring, so the identity/gateway fields are omitted.

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
	// Legacy host-minted-identity fields; the phone-anchored flow omits them (the Console owns its
	// identity + keyring).
	identity?: string;
	gatewayId?: string;
	gatewaySignPub?: string;
	gatewayBoxPub?: string;
	gatewayTransport?: string;
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

////////////////////////////////
//  CLI shim (back-compat: cluster creds + output path on the ENVIRONMENT so the saToken/appToken
//  stay out of argv)

if (import.meta.main) {
	const reqEnv = (name: string): string => {
		const v = process.env[name];
		if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
		return v;
	};
	await writeProvisioningBlob(
		{
			apiUrl: reqEnv("SB_API"),
			caPem: reqEnv("SB_CA"),
			saToken: reqEnv("SB_SA"),
			appToken: reqEnv("SB_APP"),
			namespace: process.env.SB_NS || undefined,
			service: process.env.SB_SVC || undefined,
			port: process.env.SB_PORT ? Number(process.env.SB_PORT) : undefined,
			identity: process.env.SB_CONSOLE_ID || undefined,
			gatewayId: process.env.SB_SWID || undefined,
			gatewaySignPub: process.env.SB_SSIGN || undefined,
			gatewayBoxPub: process.env.SB_SBOX || undefined,
			gatewayTransport: process.env.SB_SWTRANSPORT || undefined,
		},
		reqEnv("SB_BLOB"),
	);
}
