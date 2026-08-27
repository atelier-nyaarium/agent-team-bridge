// The gateway must actually HAND its host-spawn state to the two halves that use it.
//
// This exists because it did not. `hostSpawnPoints` was created in index.ts and passed to neither
// `createWebSocketHandlers` nor `createRoutes`, and because both deps are optional, TypeScript
// accepted it: the catalog frame had no state to write, discovery had none to read, and the whole
// feature was silently dead in production while every unit test passed. A test that builds the two
// halves separately cannot see that; only one that reads the wiring can.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

const INDEX = fs.readFileSync(path.join(import.meta.dirname, "..", "gateway", "index.ts"), "utf8");

/** The argument list of one `createX({ ... })` call in index.ts. */
function depsOf(factory: string): string {
	const start = INDEX.indexOf(`${factory}({`);
	expect(start, `${factory} is not called in index.ts`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = INDEX.indexOf("{", start); i < INDEX.length; i++) {
		if (INDEX[i] === "{") depth++;
		else if (INDEX[i] === "}" && --depth === 0) return INDEX.slice(start, i + 1);
	}
	throw new Error(`unbalanced braces reading ${factory}`);
}

////////////////////////////////
//  Tests

describe("host spawn state reaches both halves", () => {
	// Positive control: the reader must be able to FAIL. Without this an extraction bug makes every
	// assertion below pass on an empty string.
	it("the deps reader actually finds a known dependency", () => {
		expect(depsOf("createWebSocketHandlers")).toContain("offlineCatalog");
		expect(depsOf("createRoutes")).toContain("sessionStore");
	});

	// The WRITER: the daemon's catalog frame lands here.
	it("createWebSocketHandlers is given hostSpawnPoints", () => {
		expect(depsOf("createWebSocketHandlers")).toContain("hostSpawnPoints");
	});

	// The READER: discovery answers from here. Without it localSpawnPoints() is permanently unknown
	// and no machine ever advertises a Windows side.
	it("createRoutes is given hostSpawnPoints", () => {
		expect(depsOf("createRoutes")).toContain("hostSpawnPoints");
	});

	// Both halves must share ONE value, or the catalog frame writes to something discovery never
	// reads - which is the same defect wearing a different shape.
	it("exactly one host spawn state is constructed", () => {
		const declarations = INDEX.match(/const hostSpawnPoints\b/g) ?? [];
		expect(declarations).toHaveLength(1);
	});
});
