import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { sealTargetFor } from "../gateway/federation/sealTarget.js";
import { linkedPeer } from "./helpers/cross-domain-link.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function peers(rows: Array<[string, string]>): CrossDomainPeers {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-target-"));
	dirs.push(dir);
	const store = new CrossDomainPeers(dir);
	for (const [domainId, gatewayId] of rows) store.add(linkedPeer(domainId, gatewayId));
	return store;
}

describe("seal target rules", () => {
	it("prefers a local gateway over a colliding peer", () => {
		const result = sealTargetFor(
			{ resolvesLocalGateway: (id) => id === "desktop", crossDomainPeers: peers([["friend", "desktop"]]) },
			"desktop",
			"friend",
		);
		expect(result).toBe("desktop");
	});

	it("selects an explicit peer and rejects an ambiguous bare id", () => {
		const crossDomainPeers = peers([
			["aria", "desktop"],
			["briar", "desktop"],
		]);
		expect(sealTargetFor({ crossDomainPeers }, "desktop", "briar")).toEqual({
			domainId: "briar",
			gatewayId: "desktop",
		});
		expect(() => sealTargetFor({ crossDomainPeers }, "desktop")).toThrow();
	});

	it("falls through to the only peer or the bare target", () => {
		expect(sealTargetFor({ crossDomainPeers: peers([["aria", "desktop"]]) }, "desktop", "missing")).toEqual({
			domainId: "aria",
			gatewayId: "desktop",
		});
		expect(sealTargetFor({}, "unknown")).toBe("unknown");
	});
});
