import { describe, expect, it } from "vitest";
import { GATEWAY_BLOB_FETCH_WAIT_MS, GATEWAY_RELAY_TIMEOUT_MS } from "../federation-server/relayTimeouts.js";

describe("relay timeouts", () => {
	it("uses the configured gateway relay and blob wait windows", () => {
		expect(GATEWAY_RELAY_TIMEOUT_MS).toBe(70_000);
		expect(GATEWAY_BLOB_FETCH_WAIT_MS).toBe(120_000);
	});
});
