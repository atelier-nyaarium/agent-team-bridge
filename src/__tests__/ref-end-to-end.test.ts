import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_FILENAME, MANIFEST_MARKER } from "../mcp/references/artifactNames.js";
import { appendRefArtifacts, setReferencesEnabled } from "../mcp/references/attachRefs.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";

////////////////////////////////
//  Functions & Helpers

// A snapshot's bytes travel the blob plane like any other file, so building one uploads.
const h = vi.hoisted(() => ({ wire: null as BlobWire | null }));

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: async (route: string, body: unknown) => {
		if (!isBlobRoute(route) || !h.wire) throw new Error(`unexpected post to ${route}`);
		return h.wire.answer(route, body);
	},
}));

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
	// os.tmpdir() reads TMPDIR, which mounting the wire repoints, so take the ref root first.
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-e2e-"));
	h.wire = mountBlobWire();
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
	h.wire?.dispose();
	h.wire = null;
	fs.rmSync(root, { recursive: true, force: true });
});

/** A shipped artifact's text, read back off the plane it was uploaded to. An artifact that named no
 * bytes is a defect, not a supported shape. */
function shipped(blobId: string | undefined): string {
	if (blobId === undefined) throw new Error("ref artifact shipped without naming its bytes");
	if (!h.wire) throw new Error("blob wire not mounted");
	return h.wire.read(blobId).toString("utf8");
}

////////////////////////////////
//  Tests

describe("a reply that links a symbol", () => {
	it("attaches a manifest and the file it points into", async () => {
		const result = await appendRefArtifacts("Look at [add](ref://src/cart.ts:Cart:add).", []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.files.map((f) => f.filename)).toEqual([MANIFEST_FILENAME, "cart.ts"]);

		const manifest = JSON.parse(shipped(result.files[0].blobId));
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

		expect(result.ok && shipped(result.files[1].blobId)).toBe(CART);
	});

	it("keeps the agent's own attachments and adds the snapshots after them", async () => {
		const own = {
			filename: "diagram.png",
			mime: "image/png",
			size: 3,
			descriptiveKey: "diagram.png",
			blobId: `sha256-${"0".repeat(64)}`,
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
		const entry = Object.values(JSON.parse(shipped(result.files[0].blobId)).refs)[0];
		expect(entry).toMatchObject({ quality: "fuzzy", startLine: 1 });
	});

	it("opens the whole file when nothing in the chain survives, still without refusing", async () => {
		const result = await appendRefArtifacts("[gone](ref://src/cart.ts:Basket:removeEverything)", []);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = Object.values(JSON.parse(shipped(result.files[0].blobId)).refs)[0];
		expect(entry).toMatchObject({ quality: "unresolved", startLine: 1 });
	});

	it("stops the send for a file that does not exist, while the agent can still fix it", async () => {
		const result = await appendRefArtifacts("[x](ref://src/nope.ts:Foo)", []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("does not exist");
	});

	it("ignores a ref written inside a fenced example, so documenting the feature is safe", async () => {
		const body = ["Write it like:", "", "```md", "[x](ref://src/nope.ts:Foo)", "```", ""].join("\n");

		expect(await appendRefArtifacts(body, [])).toEqual({ ok: true, files: [] });
	});
});
