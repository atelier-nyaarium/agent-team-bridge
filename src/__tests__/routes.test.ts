import { describe, expect, it } from "vitest";
import { ROUTER_WS_MAX_PAYLOAD_BYTES } from "../gateway/router/routerClient.js";
import { SendRequestSchema } from "../gateway/routeSchemas.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES, MAX_RELAY_FRAME_BYTES } from "../shared/router-protocol.js";

describe("route transport size contract", () => {
	it("keeps chunked blobs below the relay and WebSocket ceilings", () => {
		expect(BLOB_CHUNK_BYTES * 2).toBeLessThan(MAX_RELAY_FRAME_BYTES);
		expect(MAX_RELAY_FRAME_BYTES).toBeLessThan(ROUTER_WS_MAX_PAYLOAD_BYTES);
		expect(MAX_BLOB_BYTES).toBeGreaterThan(ROUTER_WS_MAX_PAYLOAD_BYTES);
	});

	it("rejects a send disposition outside the wire contract", () => {
		expect(SendRequestSchema.safeParse({ from: "sender", to: "target", disposition: "later" }).success).toBe(false);
	});
});
