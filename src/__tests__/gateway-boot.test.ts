import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { armingOf, type BootState, decideBootPhase, federationOf, GatewayBootstrap } from "../gateway/boot.js";
import { loadIdentitySet, seedGateway } from "../testing/identitySet.js";

function tempPaths() {
	return { federationDir: fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-boot-")) };
}

function env(enrollNonce: string | null = null, allowFixtureIdentity = true) {
	return { enrollNonce, allowFixtureIdentity };
}

describe("GatewayBootstrap.resolve", () => {
	it("reports both missing files", () => {
		expect(GatewayBootstrap.resolve(tempPaths(), env())).toEqual({
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
		expect(GatewayBootstrap.resolve(paths, env())).toEqual({ kind: "standalone", missing: ["domainId"] });
	});

	it("arms with an enrollment nonce and no transport", () => {
		expect(GatewayBootstrap.resolve(tempPaths(), env("nonce"))).toEqual({ kind: "arming", nonce: "nonce" });
	});

	it("activates a seeded gateway", () => {
		const paths = tempPaths();
		seedGateway(paths.federationDir, loadIdentitySet(), {
			routerUrl: "https://router",
			routerCertFp: "AA",
		});
		const result = GatewayBootstrap.resolve(paths, env());
		expect(result.kind).toBe("active");
		if (result.kind === "active") expect(result.boot.domainId).toBe(loadIdentitySet().domain.id);
	});

	it("refuses a fixture identity unless allowed", () => {
		const paths = tempPaths();
		seedGateway(paths.federationDir, loadIdentitySet(), {
			routerUrl: "https://router",
			routerCertFp: "AA",
		});
		expect(() => GatewayBootstrap.resolve(paths, env(null, false))).toThrow();
		expect(GatewayBootstrap.resolve(paths, env(null, true)).kind).toBe("active");
	});
});

////////////////////////////////
//  Boot phase decision
//
//  The full input space, pinned. The two subtle rows: transport-without-Domain never self-arms
//  (re-enroll only), and nonce-with-transport stays put so re-arming cannot fork identity.

describe("decideBootPhase", () => {
	it.each([
		// [hasTransport, hasDomainId, hasEnrollNonce, expected]
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
