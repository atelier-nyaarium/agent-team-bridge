import { describe, expect, it } from "vitest";
import {
	Address,
	assertSlug,
	isSlug,
	LOCAL_DOMAIN_SENTINEL,
	parseStoreKey,
	parseTarget,
	type SessionKey,
	SpawnPoint,
	storeKey,
} from "../shared/session-id.js";

describe("isSlug", () => {
	it("accepts lowercase alnum + internal/trailing hyphen, rejects leading hyphen and separators", () => {
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
});

describe("Address / SpawnPoint", () => {
	it("canonical joins the four layers with dots", () => {
		expect(Address.of("a95dd4e979aa3be5", "sakura", "nyaadot", "ik-tracking").canonical).toBe(
			"a95dd4e979aa3be5.sakura.nyaadot.ik-tracking",
		);
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

	it("rejects an illegal segment at construction", () => {
		expect(() => Address.of("a95dd4e979aa3be5", "sakura", "my.app", "s")).toThrow(/invalid address segment/);
	});
});

describe("parseTarget (arity dispatch)", () => {
	it("1 = local spawn-point, 2 = local chat, 3 = remote spawn-point, 4 = remote chat", () => {
		const one = parseTarget("nyaadot", "a95dd4e979aa3be5", "sakura");
		expect(one).toBeInstanceOf(SpawnPoint);
		expect((one as SpawnPoint).canonical).toBe("a95dd4e979aa3be5.sakura.nyaadot");

		const two = parseTarget("nyaadot.ik-tracking", "a95dd4e979aa3be5", "sakura");
		expect(two).toBeInstanceOf(Address);
		expect((two as Address).canonical).toBe("a95dd4e979aa3be5.sakura.nyaadot.ik-tracking");

		const three = parseTarget("other.gw.proj", "a95dd4e979aa3be5", "sakura");
		expect(three).toBeInstanceOf(SpawnPoint);

		const four = parseTarget("other.gw.proj.sess", "a95dd4e979aa3be5", "sakura");
		expect(four).toBeInstanceOf(Address);
		expect((four as Address).canonical).toBe("other.gw.proj.sess");
	});

	it("throws on an empty target (empty segment) and on 5+ segments (bad arity)", () => {
		expect(() => parseTarget("", "d", "g")).toThrow(/invalid address segment/); // [""] -> arity 1, empty segment
		expect(() => parseTarget("a.b.c.d.e", "d", "g")).toThrow(/invalid address arity/);
	});
});

describe("storeKey / parseStoreKey round-trip", () => {
	const addr = Address.of("a95dd4e979aa3be5", "sakura", "nyaadot", "ik-tracking");

	it("round-trips a conv key", () => {
		const k: SessionKey = { kind: "conv", conversationId: "abc123-def", address: addr };
		const s = storeKey(k);
		expect(s).toBe("conv.abc123-def.a95dd4e979aa3be5.sakura.nyaadot.ik-tracking");
		const back = parseStoreKey(s);
		expect(back).toEqual(k);
	});

	it("round-trips a notice key", () => {
		const k: SessionKey = { kind: "notice", sender: addr };
		const s = storeKey(k);
		expect(s).toBe("notice.a95dd4e979aa3be5.sakura.nyaadot.ik-tracking");
		expect(parseStoreKey(s)).toEqual(k);
	});

	it("rejects wrong arity, a bad tag, and a non-slug segment", () => {
		expect(parseStoreKey("conv.c.d.g.s")).toBeNull(); // 5 segments, not 6
		expect(parseStoreKey("notice.d.g.s")).toBeNull(); // 4 segments, not 5
		expect(parseStoreKey("bogus.c.d.g.s.x")).toBeNull(); // unknown tag
		expect(parseStoreKey("conv.c.d.g.spawn.UP")).toBeNull(); // uppercase session
	});

	it("accepts a long (128) conversationId but rejects an over-long one", () => {
		const ok: SessionKey = { kind: "conv", conversationId: "a".repeat(128), address: addr };
		expect(parseStoreKey(storeKey(ok))).toEqual(ok);
		const tooLong = ["conv", "a".repeat(129), "d", "g", "sp", "s"].join(".");
		expect(parseStoreKey(tooLong)).toBeNull();
	});
});
