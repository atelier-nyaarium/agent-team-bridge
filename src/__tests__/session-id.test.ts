import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	Address,
	assertSlug,
	composeSessionName,
	isComposite,
	isSlug,
	LOCAL_DOMAIN_SENTINEL,
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
	it("isSlug accepts lowercase alnum + internal/trailing hyphen, rejects leading hyphen and separators", () => {
		expect(isSlug("nyaadot")).toBe(true);
		expect(isSlug("ik-tracking")).toBe(true);
		expect(isSlug("a95dd4e979aa3be5")).toBe(true);
		expect(isSlug("-foo")).toBe(false);
		expect(isSlug("my.app")).toBe(false);
		expect(isSlug("a/b")).toBe(false);
		expect(isSlug("a:b")).toBe(false);
		expect(isSlug("UPPER")).toBe(false);
		expect(isSlug("")).toBe(false);
		expect(isSlug("a".repeat(65))).toBe(false);
	});

	it("assertSlug throws on an invalid segment", () => {
		expect(() => assertSlug("my.app")).toThrow(/invalid address segment/);
	});

	it("a dotted segment is rejected at construction (no ambiguous split)", () => {
		expect(() => Address.of("d", "g", "my.app", "s")).toThrow(/invalid address segment/);
	});

	it("local fills the sentinel domain in arming mode", () => {
		expect(Address.local("", "sakura", "host", "cooking").canonical).toBe(
			`${LOCAL_DOMAIN_SENTINEL}.sakura.host.cooking`,
		);
		expect(Address.local("a95dd4e979aa3be5", "sakura", "host", "cooking").domain).toBe("a95dd4e979aa3be5");
	});

	it("spawnPoint projects an address down to its 3-layer spawn-point", () => {
		const sp = Address.of("a95dd4e979aa3be5", "sakura", "nyaadot", "ik-tracking").spawnPoint;
		expect(sp.canonical).toBe("a95dd4e979aa3be5.sakura.nyaadot");
		expect(sp.equals(SpawnPoint.of("a95dd4e979aa3be5", "sakura", "nyaadot"))).toBe(true);
	});

	it("parseTarget names the failure: empty segment vs bad arity", () => {
		expect(() => parseTarget("", "d", "g")).toThrow(/invalid address segment/); // [""] -> arity 1, empty segment
		expect(() => parseTarget("a.b.c.d.e", "d", "g")).toThrow(/invalid address arity/);
	});

	it("accepts a long (128) conversationId but rejects an over-long one", () => {
		const addr = Address.of("a95dd4e979aa3be5", "sakura", "nyaadot", "ik-tracking");
		const ok: SessionKey = { kind: "conv", conversationId: "a".repeat(128), address: addr };
		expect(parseStoreKey(storeKey(ok))).toEqual(ok);
		const tooLong = ["conv", "a".repeat(129), "d", "g", "sp", "s"].join(".");
		expect(parseStoreKey(tooLong)).toBeNull();
	});
});
