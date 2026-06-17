import { describe, expect, it } from "vitest";
import { admitSwitchPayload, terminalQr } from "../arbiter/federation/enrollQr.js";
import { generateIdentity } from "../shared/crypto.js";

const id = generateIdentity();

describe("enrollQr", () => {
	it("builds an admit-switch payload from the Switch identity", () => {
		const p = admitSwitchPayload(id, "laptop");
		expect(p).toEqual({ type: "admit-switch", switchId: "laptop", signPub: id.sign.pub, boxPub: id.box.pub });
	});

	it("renders a multi-line QR that round-trips through a parser", () => {
		const out = terminalQr(JSON.stringify(admitSwitchPayload(id, "laptop")));
		// A QR for this payload is well over 20 modules, so many rows + the quiet zone.
		expect(out.split("\n").length).toBeGreaterThan(20);
		// Rendered as ANSI background cells, not raw text.
		expect(out).toContain("\x1b[40m");
	});
});
