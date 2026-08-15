import { z } from "zod";

////////////////////////////////
//  Gateway transport creds (the gateway-bridge SA token + endpoint)
//
//  A dep-free leaf the GatewayBootstrapBundle seals (the creds a creds-less Gateway needs to reach
//  evie). The Console pulls this from evie directly (a signed TRANSPORT_REQUEST_V1 proof).

export const GatewayTransportSchema = z
	.object({
		// Absent reads as "k8s", so a bundle sealed before the Router existed still installs.
		transport: z.enum(["k8s", "direct"]).optional(),
		apiUrl: z.string().min(1).optional(),
		saToken: z.string().min(1).optional(),
		caPem: z.string().min(1).optional(),
		// The direct branch. `routerUrl` is what the GATEWAY dials, which on one host is the
		// docker-network alias rather than the LAN address the phone uses.
		routerUrl: z.string().min(1).optional(),
		routerCertFp: z.string().min(1).optional(),
		bearer: z.string().min(1).optional(),
		appToken: z.string().min(1).optional(),
	})
	// `.meta()` goes LAST: refine returns a new instance, and the codegen looks the id up by it.
	.refine(
		(value) =>
			value.transport === "direct"
				? !!value.routerUrl && !!value.routerCertFp && !!value.bearer
				: !!value.apiUrl && !!value.saToken && !!value.caPem,
		{ message: "gateway transport is missing the fields its transport requires" },
	)
	.meta({ id: "GatewayTransport" });

export type GatewayTransport = z.infer<typeof GatewayTransportSchema>;
