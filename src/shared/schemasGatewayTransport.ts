import { z } from "zod";

////////////////////////////////
//  Gateway transport creds (the gateway-bridge SA token + endpoint)
//
//  A dep-free leaf the GatewayBootstrapBundle seals (the creds a creds-less Gateway needs to reach
//  evie). The Console pulls this from evie directly (a signed TRANSPORT_REQUEST_V1 proof).

export const GatewayTransportSchema = z
	.object({
		apiUrl: z.string().min(1),
		saToken: z.string().min(1),
		caPem: z.string().min(1),
		appToken: z.string().min(1).optional(),
	})
	.meta({ id: "GatewayTransport" });

export type GatewayTransport = z.infer<typeof GatewayTransportSchema>;
