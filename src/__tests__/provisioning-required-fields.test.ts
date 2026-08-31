import { describe, expect, it } from "vitest";
import { GatewayTransportSchema } from "../shared/schemasGatewayTransport.js";
import { ProvisioningSchema } from "../shared/schemasProvisioning.js";

////////////////////////////////
//  Constants

const DIRECT = { routerUrl: "wss://router:20001", routerCertFp: "ab12" };
const RETIRED = { apiUrl: "https://api.example", caPem: "pem", saToken: "token" };

////////////////////////////////
//  Tests

describe("provisioning", () => {
	it("accepts a Router endpoint with its pinned fingerprint", () => {
		expect(ProvisioningSchema.safeParse(DIRECT).success).toBe(true);
	});

	it("refuses an endpoint with no pinned fingerprint", () => {
		expect(ProvisioningSchema.safeParse({ ...DIRECT, routerCertFp: undefined }).success).toBe(false);
	});

	// The retired shape carried no routerUrl, so it now fails the requirement rather than decoding
	// into a branch. A blob of that shape is refused on purpose.
	it("refuses a blob carrying neither field", () => {
		expect(ProvisioningSchema.safeParse(RETIRED).success).toBe(false);
	});
});

describe("gateway transport", () => {
	it("requires the endpoint, its fingerprint, and the bearer together", () => {
		expect(GatewayTransportSchema.safeParse({ ...DIRECT, bearer: "b" }).success).toBe(true);
		expect(GatewayTransportSchema.safeParse(DIRECT).success).toBe(false);
		expect(GatewayTransportSchema.safeParse(RETIRED).success).toBe(false);
	});
});
