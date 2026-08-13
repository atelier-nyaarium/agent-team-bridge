import { describe, expect, it } from "vitest";
import { armingOf, type BootState, decideBootPhase, federationOf } from "../gateway/boot.js";

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
