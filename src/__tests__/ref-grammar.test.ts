import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeUri, canonicalKey, parseRef } from "../mcp/references/refGrammar.js";

////////////////////////////////
//  Functions & Helpers

interface Vector {
	id: string;
	uri: string;
	parsed: { path: string; segments: string[]; matcher: unknown };
	canonical: string;
	distinctFrom?: string;
}

const CORPUS: { vectors: Vector[]; notRefs: string[] } = JSON.parse(
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
		CORPUS.notRefs.map((s) => [JSON.stringify(s), s] as const),
	)("declines %s, which is not a ref", (_l, uri) => {
		expect(parseRef(uri)).toBeNull();
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
