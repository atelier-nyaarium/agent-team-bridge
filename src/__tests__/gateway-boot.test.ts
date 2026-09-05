import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { armingOf, type BootState, decideBootPhase, federationOf, GatewayBootstrap } from "../gateway/boot.js";
import { processAmbient } from "../shared/ambient.js";
import { loadIdentitySet, seedGateway } from "../testing/identitySet.js";

function tempPaths() {
	return { federationDir: fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-boot-")) };
}

function io() {
	return { ambient: processAmbient() };
}

function env(enrollNonce: string | null = null, allowFixtureIdentity = true) {
	return { enrollNonce, allowFixtureIdentity };
}

describe("GatewayBootstrap.resolve", () => {
	it("reports both missing files", () => {
		expect(GatewayBootstrap.resolve(tempPaths(), env(), io())).toEqual({
			kind: "standalone",
			missing: ["transport", "domainId"],
		});
	});

	it("reports a missing Domain id", () => {
		const paths = tempPaths();
		fs.writeFileSync(
			path.join(paths.federationDir, "transport.json"),
			JSON.stringify({ routerUrl: "https://router", routerCertFp: "aa", bearer: "token" }),
		);
		expect(GatewayBootstrap.resolve(paths, env(), io())).toEqual({ kind: "standalone", missing: ["domainId"] });
	});

	it("arms with an enrollment nonce and no transport", () => {
		expect(GatewayBootstrap.resolve(tempPaths(), env("nonce"), io())).toEqual({ kind: "arming", nonce: "nonce" });
	});

	it("activates a seeded gateway", () => {
		const paths = tempPaths();
		seedGateway(paths.federationDir, loadIdentitySet(), {
			routerUrl: "https://router",
			routerCertFp: "AA",
		});
		const result = GatewayBootstrap.resolve(paths, env(), io());
		expect(result.kind).toBe("active");
		if (result.kind === "active") expect(result.boot.domainId).toBe(loadIdentitySet().domain.id);
	});

	it("refuses a fixture identity unless allowed", () => {
		const paths = tempPaths();
		seedGateway(paths.federationDir, loadIdentitySet(), {
			routerUrl: "https://router",
			routerCertFp: "AA",
		});
		expect(() => GatewayBootstrap.resolve(paths, env(null, false), io())).toThrow();
		expect(GatewayBootstrap.resolve(paths, env(null, true), io()).kind).toBe("active");
	});
});

describe("decideBootPhase", () => {
	it.each([
		// Transport without Domain stays standalone; a nonce does not re-arm it.
		[true, true, true, "activate"],
		[true, true, false, "activate"],
		[true, false, true, "standalone"],
		[true, false, false, "standalone"],
		[false, true, true, "arm"],
		[false, true, false, "standalone"],
		[false, false, true, "arm"],
		[false, false, false, "standalone"],
	] as const)("transport=%s domainId=%s nonce=%s -> %s", (hasTransport, hasDomainId, hasEnrollNonce, expected) => {
		expect(decideBootPhase({ hasTransport, hasDomainId, hasEnrollNonce })).toBe(expected);
	});
});

describe("phase accessors", () => {
	const standalone: BootState = { phase: "standalone" };
	const arming: BootState = {
		phase: "arming",
		arming: { install: () => "gw", admitPayload: {} as never },
	};
	const active: BootState = { phase: "federationActive", federation: {} as never };

	it("each accessor answers only its own phase", () => {
		expect(federationOf(standalone)).toBeNull();
		expect(federationOf(arming)).toBeNull();
		expect(federationOf(active)).not.toBeNull();
		expect(armingOf(standalone)).toBeNull();
		expect(armingOf(active)).toBeNull();
		expect(armingOf(arming)).not.toBeNull();
	});
});
