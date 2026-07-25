import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeUri, canonicalKey, parseRef, tryParseRef } from "../mcp/references/refGrammar.js";

////////////////////////////////
//  Functions & Helpers

interface Vector {
	id: string;
	uri: string;
	parsed: { path: string; segments: string[]; matcher: unknown };
	canonical: string;
	distinctFrom?: string;
}

interface ErrorVector {
	id: string;
	uri: string;
	code: string;
	offset: number;
}

const CORPUS: { vectors: Vector[]; notRefs: string[]; errors: ErrorVector[] } = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "refs", "vectors.json"), "utf8"),
);

////////////////////////////////
//  Tests

describe("the ref grammar vectors", () => {
	// Read by both runtimes. The Kotlin twin lands in Phase 3 against this same corpus, because the
	// MCP writes canonical keys into the manifest and the phone recomputes them from a tapped link:
	// if the two ever disagree, every tap misses and nothing reports why.
	it.each(CORPUS.vectors.map((v) => [v.id, v] as const))("parses %s to its declared structure", (_id, vector) => {
		expect(parseRef(vector.uri)).toEqual(vector.parsed);
	});

	it.each(CORPUS.vectors.map((v) => [v.id, v] as const))("canonicalizes %s to its declared key", (_id, vector) => {
		expect(canonicalizeUri(vector.uri)).toBe(vector.canonical);
	});

	it.each(
		CORPUS.vectors.filter((v) => v.distinctFrom).map((v) => [v.id, v] as const),
	)("keeps %s distinct from the ref it could collide with", (_id, vector) => {
		const other = CORPUS.vectors.find((v) => v.id === vector.distinctFrom);

		expect(other, `vectors.json names a distinctFrom that does not exist: ${vector.distinctFrom}`).toBeDefined();
		expect(vector.canonical).not.toBe(other?.canonical);
	});

	it.each(
		CORPUS.errors.map((e) => [e.id, e] as const),
	)("refuses %s with its declared code and offset", (_id, vector) => {
		expect(tryParseRef(vector.uri)).toMatchObject({ kind: "error", code: vector.code, offset: vector.offset });
	});

	it.each(
		CORPUS.notRefs.map((s) => [JSON.stringify(s), s] as const),
	)("declines %s, which is not a ref at all", (_l, uri) => {
		// The classification matters, not just the null: a malformed ref is ALSO null through
		// parseRef, so asserting only that cannot tell "not a ref" from "a broken one".
		expect(tryParseRef(uri)).toEqual({ kind: "not-a-ref" });
	});
});

describe("canonical keys", () => {
	it("gives two spellings of one ref the same key, so a tap finds what the agent wrote", () => {
		const spellings = [
			"ref://src/a.cpp:Ns::Cls::run",
			"ref://src/a.cpp:Ns:Cls:run",
			"<ref://src/a.cpp:Ns::Cls::run>",
			"  ref://src/a.cpp:Ns::Cls::run  ",
		];

		expect(new Set(spellings.map(canonicalizeUri)).size).toBe(1);
	});

	it("round-trips, so a key recomputed from a key is still the same key", () => {
		for (const vector of CORPUS.vectors) {
			const once = canonicalizeUri(vector.uri);
			const twice = once ? canonicalizeUri(once) : null;

			expect(twice, `${vector.id} does not round-trip`).toBe(once);
		}
	});

	it("survives a matcher made entirely of separator characters", () => {
		const ref = parseRef("ref://a.ts#%2E%2E%40%3A%23%25");

		expect(ref?.matcher).toEqual({ kind: "text", text: "..@:#%" });
		expect(ref && canonicalizeUri(canonicalKey(ref))).toBe(ref && canonicalKey(ref));
	});
});

describe("canonical keys survive re-canonicalization", () => {
	// The failure this guards is silent and total: the MCP writes a key into the manifest, the phone
	// recomputes it from the tapped link, and if one more pass changes the string every tap misses.
	const ALPHABET = ["a", ":", "#", "%", ".", "@", "<", ">", " ", "/", "-", "3A", "\t", "(", ")"];

	function generate(seed: number): string {
		let out = "";
		let n = seed;
		while (n > 0) {
			out += ALPHABET[n % ALPHABET.length];
			n = Math.floor(n / ALPHABET.length);
		}
		return out;
	}

	it("is idempotent for every component shape, so no two refs can merge after one pass", () => {
		const offenders: string[] = [];
		for (let seed = 1; seed < 40_000; seed++) {
			const piece = generate(seed);
			for (const uri of [`ref://${piece}`, `ref://a.ts:${piece}`, `ref://a.ts#${piece}`]) {
				const once = canonicalizeUri(uri);
				if (once === null) continue;
				if (canonicalizeUri(once) !== once) offenders.push(uri);
			}
		}

		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("keeps a component's own text intact through a key round trip", () => {
		for (let seed = 1; seed < 20_000; seed++) {
			const piece = generate(seed);
			const ref = parseRef(`ref://a.ts:${piece}`);
			if (!ref) continue;
			const reparsed = parseRef(canonicalKey(ref));

			expect(reparsed, `lost ${JSON.stringify(piece)}`).toEqual(ref);
		}
	});
});

describe("the grammar's stated decisions", () => {
	function parsed(uri: string) {
		const result = tryParseRef(uri);
		return result.kind === "ok" ? result.ref : result;
	}

	function errorCode(uri: string) {
		const result = tryParseRef(uri);
		return result.kind === "error" ? result.code : `unexpectedly ${result.kind}`;
	}

	it("refuses a ref with no path, rather than promoting its first segment into the path slot", () => {
		expect(errorCode("ref://:Foo")).toBe("path-required");
	});

	it("points at where the problem is, so an agent can fix the ref it wrote", () => {
		const result = tryParseRef("ref://a.ts#x@after:");

		expect(result).toMatchObject({ kind: "error", code: "empty-anchor" });
		expect(result.kind === "error" && typeof result.offset).toBe("number");
	});

	it.each([
		["ref://a.ts#", "empty-fragment"],
		["ref://a.ts#@after:y", "empty-match-text"],
		["ref://a.ts#x@after:", "empty-anchor"],
		["ref://a.ts#..b", "empty-range-bound"],
		["ref://a.ts#a..", "empty-range-bound"],
	])("refuses %s, which can never match anything", (uri, code) => {
		expect(errorCode(uri)).toBe(code);
	});

	it("lets the first structural marker win, so the rest is searchable text", () => {
		expect(parsed("ref://a.ts#x@after:y@after:z")).toMatchObject({
			matcher: { kind: "after", text: "x", anchor: "y@after:z" },
		});
		expect(parsed("ref://a.ts#a..b..c")).toMatchObject({ matcher: { kind: "range", from: "a", to: "b..c" } });
	});

	it("decides a mixed fragment by position, not by which branch is written first", () => {
		expect(parsed("ref://a.ts#x..y@after:z")).toMatchObject({
			matcher: { kind: "range", from: "x", to: "y@after:z" },
		});
		expect(parsed("ref://a.ts#x@after:y..z")).toMatchObject({
			matcher: { kind: "after", text: "x", anchor: "y..z" },
		});
	});

	it("treats a run of three dots as text, since that is a spread and a variadic", () => {
		expect(parsed("ref://a.ts#...args")).toMatchObject({ matcher: { kind: "text", text: "...args" } });
	});

	it("treats an at-sign with no anchor keyword as text, so an email needs no encoding", () => {
		expect(parsed("ref://a.ts#user@example.com")).toMatchObject({
			matcher: { kind: "text", text: "user@example.com" },
		});
	});

	it("merges an empty segment, which is what the C++ double colon spelling relies on", () => {
		expect(parsed("ref://a.cpp:A::B::run")).toMatchObject({ segments: ["A", "B", "run"] });
		expect(parsed("ref://a.ts:")).toMatchObject({ path: "a.ts", segments: [] });
	});

	it("decodes a multi-escape character as one character, not as broken bytes", () => {
		expect(parsed("ref://src/%E6%97%A5.ts:Foo")).toMatchObject({ path: "src/日.ts" });
	});

	it("keeps an encoded separator as text, which is the whole reason it lexes before decoding", () => {
		expect(parsed("ref://we%3Aird.ts:Foo")).toMatchObject({ path: "we:ird.ts", segments: ["Foo"] });
	});

	it("says plainly when something is not a ref at all, distinct from being a broken one", () => {
		expect(tryParseRef("https://example.com")).toEqual({ kind: "not-a-ref" });
		expect(tryParseRef("ref://a.ts#")).toMatchObject({ kind: "error" });
	});

	it("never throws, whatever it is handed", () => {
		const nasty = [
			"ref://",
			"ref://%",
			"ref://%%%",
			"ref://%ZZ",
			"ref://a#%FF",
			`ref://${"%3A".repeat(500)}`,
			"<>",
			"<ref://>",
		];

		for (const uri of nasty) expect(() => tryParseRef(uri)).not.toThrow();
	});
});
