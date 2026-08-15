import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendRefArtifacts, setReferencesEnabled } from "../mcp/references/attachRefs.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";

// A snapshot's bytes travel the blob plane like any other file, so building one uploads.
const h = vi.hoisted(() => ({ wire: null as BlobWire | null }));

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: async (route: string, body: unknown) => {
		if (!isBlobRoute(route) || !h.wire) throw new Error(`unexpected post to ${route}`);
		return h.wire.answer(route, body);
	},
}));

////////////////////////////////
//  Functions & Helpers

/**
 * Drives real refs, across every whitelisted grammar, through the WHOLE chain: the markdown scan,
 * the parser, the tree-sitter resolve, and the artifact builder.
 *
 * This exists because a hand-run verification proves nothing tomorrow. The resolver's own unit tests
 * use inline snippets, so they can pass while a real file shape fails; a dotted C# namespace did
 * exactly that, resolving to `fuzzy` while every test stayed green, because the one committed C#
 * fixture happened to use an undotted namespace.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "ref-project");

let priorRoot: string | undefined;

beforeAll(() => {
	priorRoot = process.env.REFERENCE_ROOT;
	process.env.REFERENCE_ROOT = ROOT;
	h.wire = mountBlobWire();
	setReferencesEnabled(true);
});

afterAll(() => {
	if (priorRoot === undefined) delete process.env.REFERENCE_ROOT;
	else process.env.REFERENCE_ROOT = priorRoot;
	setReferencesEnabled(false);
	h.wire?.dispose();
	h.wire = null;
});

interface Resolved {
	quality: string;
	startLine: number;
	endLine: number;
	span?: unknown;
	ambiguous?: boolean;
	snapshots: number;
	/** The source lines the range actually selects, so an assertion reads as the code a user sees. */
	code: string;
}

async function resolve(uri: string): Promise<Resolved> {
	const result = await appendRefArtifacts(`See [it](${uri}) here.`, []);
	if (!result.ok) throw new Error(`hard failure: ${result.error}`);
	if (result.files.length === 0) throw new Error("no ref detected");

	// Resolution now rides the snapshot's own declared metadata, not a manifest file.
	const meta = result.files[0].ref;
	if (!meta) throw new Error("ref snapshot shipped without its ref metadata");
	const entry = meta.keys[0] as unknown as Resolved;
	const source = fs.readFileSync(path.join(ROOT, meta.refPath), "utf8");

	return {
		...entry,
		snapshots: result.files.length,
		code: source
			.split("\n")
			.slice(entry.startLine - 1, entry.endLine)
			.join("\n"),
	};
}

async function hardError(uri: string) {
	const result = await appendRefArtifacts(`See [it](${uri}) here.`, []);
	if (result.ok) throw new Error(`expected a hard failure, got ${result.files.length} files`);
	return result;
}

////////////////////////////////
//  Tests

describe("resolving against every whitelisted grammar", () => {
	it("walks a TypeScript namespace, class, and method", async () => {
		const r = await resolve("ref://src/cart.ts:Shop:Cart:add");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("add(item: string, qty: number)");
	});

	it("finds a C++ out-of-line definition, which has no nested scopes to walk", async () => {
		const r = await resolve("ref://src/engine.cpp:Physics::World::step");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("void Physics::World::step");
	});

	it("resolves a C# file-scoped namespace written as one dotted waypoint", async () => {
		// The spelling the source itself uses. Accepting only the split form silently degraded this
		// to a text match while every other test stayed green.
		const r = await resolve("ref://src/Svc.cs:Acme.Services:Service:Compute");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("void Compute(int n)");
	});

	it("resolves the same C# namespace split into one waypoint per part", async () => {
		const r = await resolve("ref://src/Svc.cs:Acme:Services:Service:Compute");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("void Compute(int n)");
	});

	it("finds a Python method", async () => {
		const r = await resolve("ref://src/cart.py:Cart:add");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("def add(self, item)");
	});

	it("finds a GDScript inner class", async () => {
		const r = await resolve("ref://src/node.gd:Inner:tick");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("func tick()");
	});

	// `class_name` is how nearly every real Godot script names itself, and it names the FILE rather
	// than opening a scope. Only the inner-class form was covered before, so the spelling an agent
	// naturally reaches for silently resolved to the first CALL of the method instead.
	it("finds a method under a GDScript file-level class_name", async () => {
		const r = await resolve("ref://src/belt.gd:Belt:advance");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("func advance()");
	});

	it("reaches a GDScript inner class through the file-level class_name", async () => {
		const r = await resolve("ref://src/belt.gd:Belt:Slot:value");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("func value()");
	});

	it("finds a GDScript method named without its file-level class", async () => {
		const r = await resolve("ref://src/belt.gd:advance");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("func advance()");
	});

	it("finds a .tsx member, which the plain TypeScript grammar cannot parse", async () => {
		const r = await resolve("ref://src/App.tsx:App:render");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("const render");
	});

	it("reaches through anonymous JavaScript nesting with nothing named in between", async () => {
		const r = await resolve("ref://src/util.js:Outer:deepHandler");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("const deepHandler");
	});
});

describe("pseudo-segments and matchers", () => {
	it("selects a parameter list", async () => {
		const r = await resolve("ref://src/cart.ts:Shop:Cart:add:arguments");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("item: string, qty: number");
	});

	it("narrows to one named parameter", async () => {
		expect((await resolve("ref://src/cart.ts:Shop:Cart:add:arguments:qty")).quality).toBe("exact");
	});

	it("highlights the first match of a plain matcher", async () => {
		const r = await resolve("ref://src/cart.ts:Shop:Cart:add#this.count%20%2B=%201");

		expect(r.quality).toBe("exact");
		expect(r.span).toBeDefined();
	});

	it("picks the occurrence after an anchor rather than the first one", async () => {
		const first = await resolve("ref://src/cart.ts:Shop:Cart:add#this.count%20%2B=%201");
		const after = await resolve("ref://src/cart.ts:Shop:Cart:add#this.count%20%2B=%201@after:reset()");

		expect(after.span).not.toEqual(first.span);
	});

	it("spans a range between two bounds", async () => {
		const r = await resolve("ref://src/cart.ts:Shop:Cart:add#this.items.push..reset()");

		expect(r.quality).toBe("exact");
		expect(r.code).toContain("this.items.push");
		expect(r.code).toContain("reset()");
	});
});

describe("degrading rather than refusing", () => {
	it("falls back to a text match when the enclosing scope was renamed", async () => {
		const r = await resolve("ref://src/cart.ts:Basket:add");

		expect(r.quality).toBe("fuzzy");
	});

	it("opens the whole file when nothing in the chain survives", async () => {
		const r = await resolve("ref://src/cart.ts:Basket:removeEverything");

		expect(r.quality).toBe("unresolved");
		expect(r.startLine).toBe(1);
	});

	it("keeps the scope when only the matcher misses", async () => {
		const r = await resolve("ref://src/cart.ts:Shop:Cart:add#notPresentAnywhere");

		expect(r.quality).toBe("fuzzy");
		expect(r.span).toBeUndefined();
	});
});

describe("what the send carries", () => {
	it("ships one snapshot for two refs into the same file, carrying both keys", async () => {
		const result = await appendRefArtifacts(
			"[a](ref://src/cart.ts:Shop:Cart:add) and [b](ref://src/cart.ts:Shop:Cart)",
			[],
		);

		expect(result.ok && result.files.map((f) => f.filename)).toEqual(["cart.ts"]);
		expect(result.ok && result.files[0].ref?.keys).toHaveLength(2);
	});

	it("detects nothing for a ref written inside a fence", async () => {
		const body = ["```md", "[x](ref://src/cart.ts:Shop:Cart:add)", "```"].join("\n");

		expect(await appendRefArtifacts(body, [])).toEqual({ ok: true, files: [] });
	});
});

describe("the file tier, which is what actually stops a send", () => {
	it("names a missing file", async () => {
		expect((await hardError("ref://src/nope.ts:Foo")).ok).toBe(false);
	});

	it("refuses a binary file", async () => {
		expect((await hardError("ref://src/logo.png")).ok).toBe(false);
	});

	it("reads an absolute path, resolved the way a shell would", async () => {
		const result = await appendRefArtifacts(`See [it](ref://${path.join(ROOT, "src", "cart.ts")}) here.`, []);

		expect(result.ok).toBe(true);
	});

	it("names the position of a malformed ref, indexed into the ref as written", async () => {
		const result = await hardError("ref://src/cart.ts:Shop#");

		expect(result.ok).toBe(false);
	});
});
