import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonError, type Session } from "@nyaa-lexicon/client";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendRefArtifacts,
	setLexiconRoot,
	setReferencesEnabled,
	setSessionFactory,
} from "../mcp/references/attachRefs.js";
import { resetWorkspaceRoot } from "../mcp/references/refWorkspace.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";

////////////////////////////////
//  Functions & Helpers

const h = vi.hoisted(() => ({ wire: null as BlobWire | null }));

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: async (route: string, body: unknown) => {
		if (!isBlobRoute(route) || !h.wire) throw new Error(`unexpected post to ${route}`);
		return h.wire.answer(route, body);
	},
}));

const CART = ["export class Cart {", "\tadd(item: string): void {", "\t\tthis.items.push(item);", "\t}", "}", ""].join(
	"\n",
);

let root: string;
let install: string;
let priorRoot: string | undefined;
let priorState: string | undefined;

/** An install root shaped as the client reads one: a bundle and a version file under dist/. */
function installAt(bundle: "file" | "directory", protocolVersion: string): void {
	fs.mkdirSync(path.join(install, "dist"), { recursive: true });
	const daemon = path.join(install, "dist", "daemon.js");
	if (bundle === "file") fs.writeFileSync(daemon, "// bundle\n");
	else fs.mkdirSync(daemon, { recursive: true });
	fs.writeFileSync(
		path.join(install, "dist", "version.json"),
		JSON.stringify({ buildVersion: "2.9.9", protocolVersion }),
	);
}

beforeEach(() => {
	// os.tmpdir() reads TMPDIR, which mounting the wire repoints, so take the roots first.
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-degraded-"));
	install = fs.mkdtempSync(path.join(os.tmpdir(), "ref-install-"));
	priorState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ref-state-"));
	h.wire = mountBlobWire();
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "cart.ts"), CART);
	priorRoot = process.env.REFERENCE_ROOT;
	process.env.REFERENCE_ROOT = root;
	resetWorkspaceRoot();
	setLexiconRoot(install);
	setSessionFactory(null);
	setReferencesEnabled(true);
});

afterEach(() => {
	if (priorRoot === undefined) delete process.env.REFERENCE_ROOT;
	else process.env.REFERENCE_ROOT = priorRoot;
	const state = process.env.XDG_STATE_HOME;
	if (priorState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = priorState;
	setReferencesEnabled(false);
	setSessionFactory(null);
	setLexiconRoot(undefined);
	resetWorkspaceRoot();
	h.wire?.dispose();
	h.wire = null;
	for (const dir of [root, install, state]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function attach(body: string) {
	const result = await appendRefArtifacts(body, []);
	if (!result.ok) throw new Error(`the reply was refused: ${result.error}`);
	return { key: result.files[0]?.ref?.keys[0], notices: result.notices };
}

////////////////////////////////
//  Tests

describe("only lexicon's absence degrades, and the reply says so", () => {
	it("matches by text and notices when no lexicon is installed", async () => {
		const { key, notices } = await attach("[add](ref://src/cart.ts:Cart:add)");

		expect(key).toMatchObject({ quality: "fuzzy", startLine: 2, endLine: 2 });
		expect(key?.reason).toContain("not installed");
		expect(notices).toEqual([expect.stringContaining("refs: lexicon is not installed")]);
	});

	it("refuses an install behind this client's protocol major before any spawn", async () => {
		installAt("file", "2.0.0");

		const { key, notices } = await attach("[add](ref://src/cart.ts:Cart:add)");

		expect(key).toMatchObject({ quality: "fuzzy" });
		expect(key?.reason).toContain("cannot serve this client");
		expect(notices).toHaveLength(1);
	});

	it("reads an install with nothing runnable as no install, without waiting on a spawn", async () => {
		installAt("directory", PROTOCOL_VERSION);

		const started = Date.now();
		const { key, notices } = await attach("[add](ref://src/cart.ts:Cart:add)");

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(key).toMatchObject({ quality: "fuzzy" });
		expect(key?.reason).toContain(`no lexicon install under ${install}`);
		expect(notices).toEqual([expect.stringContaining("refs: lexicon is not installed")]);
	});

	it("opens the whole file when no segment matches by text either", async () => {
		const { key } = await attach("[gone](ref://src/cart.ts:Basket:removeEverything)");

		expect(key).toMatchObject({ quality: "unresolved", startLine: 1, endLine: 6 });
		expect(key?.reason).toContain("no segment matched by text");
	});

	it("degrades as warming when the daemon's wait ran out, naming what it waited on", async () => {
		const fake = {
			resolveChain: async () => {
				throw new DaemonError(
					"starting (gave up waiting on the warmup pass; ask again later)",
					"daemon",
					"the warmup pass",
				);
			},
		} as unknown as Session;
		setSessionFactory(async () => fake);

		const { key, notices } = await attach("[add](ref://src/cart.ts:Cart:add)");

		expect(key).toMatchObject({ quality: "fuzzy" });
		expect(key?.reason).toContain("warming");
		expect(notices[0]).toContain("send again");
		expect(notices[0]).toContain("the warmup pass");
	});

	it("dedupes notices by cause across several refs in one reply", async () => {
		const result = await appendRefArtifacts("[a](ref://src/cart.ts:Cart:add) and [b](ref://src/cart.ts:Cart)", []);

		expect(result.ok && result.notices).toHaveLength(1);
	});
});
