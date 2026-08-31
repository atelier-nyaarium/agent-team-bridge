import { z } from "zod";

////////////////////////////////
//  Gateway transport creds (the gateway-bridge SA token + endpoint)
//
//  A dep-free leaf the GatewayBootstrapBundle seals (the creds a creds-less Gateway needs to reach
//  the Router). The Console pulls this from the Router directly (a signed TRANSPORT_REQUEST_V1 proof).

export const GatewayTransportSchema = z
	.object({
		// `routerUrl` is what the GATEWAY dials, which on one host is the docker-network alias
		// rather than the LAN address the phone uses.
		routerUrl: z.string().min(1).optional(),
		routerCertFp: z.string().min(1).optional(),
		bearer: z.string().min(1).optional(),
	})
	// Optional at the type level because the Kotlin codegen sees flat fields; all three are required
	// together, and this is the one place that pairing is enforced.
	// `.meta()` goes LAST: refine returns a new instance, and the codegen looks the id up by it.
	.refine((value) => !!value.routerUrl && !!value.routerCertFp && !!value.bearer, {
		message: "gateway transport is missing its Router endpoint, pinned fingerprint, or bearer",
	})
	.meta({ id: "GatewayTransport" });
