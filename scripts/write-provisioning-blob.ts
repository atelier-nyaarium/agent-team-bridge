// Assemble + VALIDATE the provisioning blob, then write it (provision-console.sh emit_blob).
//
// The blob is validated against the SHARED ProvisioningSchema before it is written, so a
// producer/schema field drift (a rename here, a missing field there) fails LOUDLY at
// provision time on the host instead of silently on the device after import. bun-only;
// inputs ride the ENVIRONMENT so the saToken/appToken/console identity stay out of argv.
//   env in: SB_API SB_CA SB_SA SB_APP (cluster creds), SB_NS SB_SVC SB_PORT, SB_BLOB
//           (output path). In the phone-anchored model the blob is transport-only: the
//           Console generates its own identity and resolves Switch keys from the synced
//           keyring, so the identity/switch fields are omitted.

import { ProvisioningSchema } from "../src/shared/schemas.js";

function reqEnv(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

const blob = {
	apiUrl: reqEnv("SB_API"),
	caPem: reqEnv("SB_CA"),
	saToken: reqEnv("SB_SA"),
	appToken: reqEnv("SB_APP"),
	namespace: process.env.SB_NS || undefined,
	service: process.env.SB_SVC || undefined,
	port: process.env.SB_PORT ? Number(process.env.SB_PORT) : undefined,
	// Optional: a legacy host-minted-identity blob still carries these, but the
	// phone-anchored flow omits them (the Console owns its identity + keyring).
	identity: process.env.SB_CONSOLE_ID || undefined,
	switchId: process.env.SB_SWID || undefined,
	switchSignPub: process.env.SB_SSIGN || undefined,
	switchBoxPub: process.env.SB_SBOX || undefined,
	// A JSON-encoded SwitchTransport: the switch-bridge creds the owner Console seals into
	// a bootstrap bundle when it enrolls a creds-less Switch.
	switchTransport: process.env.SB_SWTRANSPORT || undefined,
};

// .parse throws (non-zero exit) on any type/shape mismatch and strips unknown keys, so the
// written blob is exactly the schema's shape.
const parsed = ProvisioningSchema.parse(blob);
await Bun.write(reqEnv("SB_BLOB"), `${JSON.stringify(parsed, null, 2)}\n`);
