import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	Address,
	composeSessionName,
	isComposite,
	parseSessionName,
	parseStoreKey,
	parseTarget,
	type SessionKey,
	SpawnPoint,
	storeKey,
} from "../shared/session-id.js";

////////////////////////////////
//  Cross-runtime address vectors
//
//  vectors.json is read by BOTH this suite and SessionIdVectorsTest.kt, so the hand-authored Kotlin
//  twin cannot drift from the TS source: a canonical string either side produces differently fails
//  one of the two runtimes.

interface AddressVector {
	domain: string;
	gateway: string;
	spawn: string;
	session: string;
	canonical: string;
	spawnPointCanonical: string;
}
interface ParseTargetVector {
	input: string;
	localDomain: string;
	localGateway: string;
	kind: "spawn" | "address";
	canonical: string;
}
interface StoreKeyVector {
	kind: "conv" | "notice";
	conversationId?: string;
	domain: string;
	gateway: string;
	spawn: string;
	session: string;
	key: string;
}
interface SessionNameVector {
	input: string;
	project: string;
	session: string;
	composite: boolean;
	composed: string;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/session-id/vectors.json"), "utf8"),
) as {
	address: AddressVector[];
	parseTarget: ParseTargetVector[];
	parseTargetReject: string[];
	storeKey: StoreKeyVector[];
	parseStoreKeyReject: string[];
	sessionName: SessionNameVector[];
};

describe("address vectors", () => {
	it.each(vectors.address.map((v) => [v.canonical, v] as const))("Address %s", (_, v) => {
		const a = Address.of(v.domain, v.gateway, v.spawn, v.session);
		expect(a.canonical).toBe(v.canonical);
		expect(a.spawnPoint.canonical).toBe(v.spawnPointCanonical);
	});

	it.each(vectors.parseTarget.map((v) => [v.input, v] as const))("parseTarget %s", (_, v) => {
		const t = parseTarget(v.input, v.localDomain, v.localGateway);
		expect(t instanceof SpawnPoint ? "spawn" : "address").toBe(v.kind);
		expect(t.canonical).toBe(v.canonical);
	});

	it.each(vectors.parseTargetReject.map((s) => [JSON.stringify(s), s] as const))("parseTarget rejects %s", (_, s) => {
		expect(() => parseTarget(s, "local", "gw")).toThrow();
	});

	it.each(vectors.storeKey.map((v) => [v.key, v] as const))("storeKey %s", (_, v) => {
		const k: SessionKey =
			v.kind === "conv"
				? {
						kind: "conv",
						conversationId: v.conversationId ?? "",
						address: Address.of(v.domain, v.gateway, v.spawn, v.session),
					}
				: { kind: "notice", sender: Address.of(v.domain, v.gateway, v.spawn, v.session) };
		expect(storeKey(k)).toBe(v.key);
		// parseStoreKey is the exact inverse (store-key == lookup-key).
		expect(parseStoreKey(v.key)).toEqual(k);
	});

	it.each(
		vectors.parseStoreKeyReject.map((s) => [JSON.stringify(s), s] as const),
	)("parseStoreKey rejects %s", (_, s) => {
		expect(parseStoreKey(s)).toBeNull();
	});

	it.each(vectors.sessionName.map((v) => [v.input, v] as const))("local team-field codec %s", (_, v) => {
		expect(parseSessionName(v.input)).toEqual({ project: v.project, session: v.session });
		expect(isComposite(v.input)).toBe(v.composite);
		expect(composeSessionName(v.project, v.session)).toBe(v.composed);
	});
});

describe("address grammar invariants", () => {
	it("a store key is byte-stable regardless of the parsing gateway (fully qualified, no local resolution)", () => {
		const key = "conv.c.a95dd4e979aa3be5.sakura.nyaadot.ik-tracking";
		expect(parseStoreKey(key)).not.toBeNull();
		expect(storeKey(parseStoreKey(key) as SessionKey)).toBe(key);
	});

	it("a dotted segment is rejected at construction (no ambiguous split)", () => {
		expect(() => Address.of("d", "g", "my.app", "s")).toThrow(/invalid address segment/);
	});

	it("a local target with our (domain, gateway) round-trips through parseTarget", () => {
		const t = parseTarget("nyaadot.ik-tracking", "a95dd4e979aa3be5", "sakura");
		expect(t).toBeInstanceOf(Address);
		expect((t as Address).domain).toBe("a95dd4e979aa3be5");
		expect((t as Address).gateway).toBe("sakura");
	});
});
