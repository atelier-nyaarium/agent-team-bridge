import { describe, expect, it } from "vitest";
import { GatewayTransportSchema } from "../shared/schemasGatewayTransport.js";
import { ProvisioningSchema } from "../shared/schemasProvisioning.js";

////////////////////////////////
//  Constants

const K8S = { apiUrl: "https://api.example", caPem: "pem", saToken: "token" };
const DIRECT = { transport: "direct" as const, routerUrl: "wss://router:20001", routerCertFp: "ab12" };

////////////////////////////////
//  Tests

describe("provisioning transport branches", () => {
	it("reads a blob with no transport as the k8s branch", () => {
		const parsed = ProvisioningSchema.parse(K8S);
		expect(parsed.transport).toBeUndefined();
		expect(parsed.apiUrl).toBe(K8S.apiUrl);
	});

	it("accepts a direct blob carrying no k8s fields", () => {
		expect(ProvisioningSchema.safeParse(DIRECT).success).toBe(true);
	});

	it("refuses a branch that is missing its own fields", () => {
		expect(ProvisioningSchema.safeParse({ ...DIRECT, routerCertFp: undefined }).success).toBe(false);
		expect(ProvisioningSchema.safeParse({ ...K8S, saToken: undefined }).success).toBe(false);
	});

	it("keeps an old record's port in the proxy sense", () => {
		const parsed = ProvisioningSchema.parse({ ...K8S, port: 20004 });
		expect({ transport: parsed.transport, port: parsed.port }).toEqual({ transport: undefined, port: 20004 });
	});
});

describe("gateway transport branches", () => {
	it("accepts either branch and refuses a half-filled one", () => {
		expect(GatewayTransportSchema.safeParse({ apiUrl: "u", saToken: "s", caPem: "c" }).success).toBe(true);
		expect(
			GatewayTransportSchema.safeParse({
				transport: "direct",
				routerUrl: "wss://router:20001",
				routerCertFp: "ab12",
				bearer: "b",
			}).success,
		).toBe(true);
		expect(GatewayTransportSchema.safeParse({ transport: "direct", routerUrl: "wss://router:20001" }).success).toBe(
			false,
		);
	});
});
