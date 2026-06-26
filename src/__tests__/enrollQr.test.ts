import { describe, expect, it } from "vitest";
import { admitGatewayPayload, terminalQr } from "../gateway/federation/enrollQr.js";
import { generateIdentity } from "../shared/crypto.js";

const id = generateIdentity();

describe("enrollQr", () => {
	it("builds an admit-gateway payload from the Gateway identity", () => {
		const p = admitGatewayPayload(id, "laptop");
		expect(p).toEqual({ type: "admit-gateway", gatewayId: "laptop", signPub: id.sign.pub, boxPub: id.box.pub });
	});

	it("carries the pinned LAN listener (host/port/certFp) when a delivery has one", () => {
		const p = admitGatewayPayload(id, "laptop", {
			nonce: "n0nce",
			lan: { host: "192.168.1.5", port: 20003, certFp: "deadbeef" },
		});
		expect(p.nonce).toBe("n0nce");
		expect(p.lan).toEqual({ host: "192.168.1.5", port: 20003, certFp: "deadbeef" });
	});

	it("carries only the nonce (no lan) when the delivery has no listener (paste path)", () => {
		const p = admitGatewayPayload(id, "laptop", { nonce: "n0nce" });
		expect(p.nonce).toBe("n0nce");
		expect(p.lan).toBeUndefined();
	});

	it("renders a multi-line QR that round-trips through a parser", () => {
		const out = terminalQr(JSON.stringify(admitGatewayPayload(id, "laptop")));
		// A QR for this payload is well over 20 modules, so many rows + the quiet zone.
		expect(out.split("\n").length).toBeGreaterThan(20);
		// Rendered as ANSI background cells, not raw text.
		expect(out).toContain("\x1b[40m");
	});
});
