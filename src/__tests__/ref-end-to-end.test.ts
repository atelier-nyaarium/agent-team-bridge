import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FILENAME, MANIFEST_MARKER } from "../mcp/references/artifactNames.js";
import { appendRefArtifacts, setReferencesEnabled } from "../mcp/references/attachRefs.js";

////////////////////////////////
//  Functions & Helpers

let root: string;
let priorRoot: string | undefined;

const CART = [
	"export class Cart {",
	"\tadd(item: string): void {",
	"\t\tthis.items.push(item);",
	"\t}",
	"",
	"\tclear(): void {",
	"\t\tthis.items = [];",
	"\t}",
	"}",
	"",
].join("\n");

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-e2e-"));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "cart.ts"), CART);
	priorRoot = process.env.REFERENCE_ROOT;
	process.env.REFERENCE_ROOT = root;
	setReferencesEnabled(true);
});

afterEach(() => {
	if (priorRoot === undefined) delete process.env.REFERENCE_ROOT;
	else process.env.REFERENCE_ROOT = priorRoot;
	setReferencesEnabled(false);
	fs.rmSync(root, { recursive: true, force: true });
});

function decode(base64: string): string {
	return Buffer.from(base64, "base64").toString("utf8");
}

////////////////////////////////
//  Tests

describe("a reply that links a symbol", () => {
	it("attaches a manifest and the file it points into", async () => {
		const result = await appendRefArtifacts("Look at [add](ref://src/cart.ts:Cart:add).", []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.files.map((f) => f.filename)).toEqual([MANIFEST_FILENAME, "cart.ts"]);

		const manifest = JSON.parse(decode(result.files[0].base64));
		expect(manifest[MANIFEST_MARKER]).toBe(1);
		expect(manifest.refs["ref://src/cart.ts:Cart:add"]).toMatchObject({
			refPath: "src/cart.ts",
			startLine: 2,
			endLine: 4,
			quality: "exact",
		});
	});

	it("ships the file's real text, so the viewer renders what the agent was looking at", async () => {
		const result = await appendRefArtifacts("[add](ref://src/cart.ts:Cart:add)", []);

		expect(result.ok && decode(result.files[1].base64)).toBe(CART);
	});

	it("keeps the agent's own attachments and adds the snapshots after them", async () => {
		const own = {
			filename: "diagram.png",
			mime: "image/png",
			size: 3,
			descriptiveKey: "diagram.png",
			base64: "AAA=",
		};

		const result = await appendRefArtifacts("[add](ref://src/cart.ts:Cart:add)", [own]);

		expect(result.ok && result.files.map((f) => f.filename)).toEqual(["diagram.png", MANIFEST_FILENAME, "cart.ts"]);
	});

	it("attaches nothing when the message links no refs", async () => {
		expect(await appendRefArtifacts("Just prose, no links.", [])).toEqual({ ok: true, files: [] });
	});

	it("attaches nothing when the owner has no console that renders them", async () => {
		setReferencesEnabled(false);

		expect(await appendRefArtifacts("[add](ref://src/cart.ts:Cart:add)", [])).toEqual({ ok: true, files: [] });
	});
});

describe("what stops a send and what does not", () => {
	it("degrades a renamed method to its surviving scope rather than refusing to send", async () => {
		const result = await appendRefArtifacts("[gone](ref://src/cart.ts:Cart:removeEverything)", []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = Object.values(JSON.parse(decode(result.files[0].base64)).refs)[0];
		expect(entry).toMatchObject({ quality: "fuzzy", startLine: 1 });
	});

	it("opens the whole file when nothing in the chain survives, still without refusing", async () => {
		const result = await appendRefArtifacts("[gone](ref://src/cart.ts:Basket:removeEverything)", []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = Object.values(JSON.parse(decode(result.files[0].base64)).refs)[0];
		expect(entry).toMatchObject({ quality: "unresolved", startLine: 1 });
	});

	it("stops the send for a file that does not exist, while the agent can still fix it", async () => {
		const result = await appendRefArtifacts("[x](ref://src/nope.ts:Foo)", []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("does not exist");
	});

	it("stops the send for a ref reaching outside the project", async () => {
		const result = await appendRefArtifacts("[x](ref://../../etc/passwd)", []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("project-relative");
	});

	it("ignores a ref written inside a fenced example, so documenting the feature is safe", async () => {
		const body = ["Write it like:", "", "```md", "[x](ref://src/nope.ts:Foo)", "```", ""].join("\n");

		expect(await appendRefArtifacts(body, [])).toEqual({ ok: true, files: [] });
	});
});
