import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type Session } from "@nyaa-lexicon/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRefArtifacts, setReferencesEnabled, setSessionFactory } from "../mcp/references/attachRefs.js";
import { resetWorkspaceRoot } from "../mcp/references/refWorkspace.js";
import { type BlobWire, isBlobRoute, mountBlobWire } from "./helpers/blobWire.js";

////////////////////////////////
//  Functions & Helpers

// A snapshot's bytes travel the blob plane like any other file, so building one uploads.
const h = vi.hoisted(() => ({ wire: null as BlobWire | null }));

vi.mock("../mcp/bridge/helpers.js", () => ({
	opLedgerRefusal: () => null,
	routerPost: async (route: string, body: unknown) => {
		if (!isBlobRoute(route) || !h.wire) throw new Error(`unexpected post to ${route}`);
		return h.wire.answer(route, body);
	},
}));

const REPO = path.join(import.meta.dirname, "..", "..");
const LEXICON = path.join(REPO, "lexicon");
const FIXTURE = path.join(REPO, "tests", "fixtures", "ref-project");
const FILES = [
	"src/cart.ts",
	"src/engine.cpp",
	"src/Svc.cs",
	"src/belt.gd",
	"src/node.gd",
	"src/App.tsx",
	"src/util.js",
	"src/cart.py",
];

/** A marketplace clone leaves the submodule empty, and then there is no daemon to spawn. */
const built = fs.existsSync(path.join(LEXICON, "dist", "daemon.js"));

let root: string;
let stateDir: string;
let stateHome: string;
let session: Session;
let priorRoot: string | undefined;
let priorState: string | undefined;

function git(args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** The snapshot key a reply carried for one ref, or the refusal it met. */
async function attach(body: string) {
	const result = await appendRefArtifacts(body, []);
	if (!result.ok) return { refused: result.error, key: undefined, notices: [] as string[] };
	return { refused: undefined, key: result.files[0]?.ref?.keys[0], notices: result.notices };
}

async function keyOf(uri: string) {
	const { refused, key } = await attach(`[x](${uri})`);
	if (refused !== undefined) throw new Error(refused);
	if (key === undefined) throw new Error(`${uri} shipped no key`);
	return key;
}

async function refusalOf(uri: string): Promise<string> {
	const { refused } = await attach(`[x](${uri})`);
	if (refused === undefined) throw new Error(`${uri} was not refused`);
	return refused;
}

////////////////////////////////
//  Tests

describe.skipIf(!built)("refs resolved on the index", () => {
	beforeAll(async () => {
		// os.tmpdir() reads TMPDIR, which mounting the wire repoints, so every root is taken first.
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-e2e-"));
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ref-e2e-state-"));
		stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ref-e2e-home-"));
		fs.cpSync(FIXTURE, root, { recursive: true });
		git(["init", "-q"]);
		git(["add", "-A"]);
		priorRoot = process.env.REFERENCE_ROOT;
		priorState = process.env.XDG_STATE_HOME;
		process.env.REFERENCE_ROOT = root;
		// The spawned daemon records its install under the state home; a test's stays out of the machine's.
		process.env.XDG_STATE_HOME = stateHome;
		resetWorkspaceRoot();

		session = await connect({ workspaceRoot: root, lexiconRoot: LEXICON, stateDir, patience: 120_000 });
		// Warmed here, so no `it` pays the index.
		for (const file of FILES) await session.awaitIndexed(file);
		setSessionFactory(async () => session);
	}, 180_000);

	afterAll(async () => {
		setSessionFactory(null);
		// Undefined when setup failed, and then there is no daemon of ours to stop.
		if (session !== undefined) await session.stopDaemon();
		if (priorRoot === undefined) delete process.env.REFERENCE_ROOT;
		else process.env.REFERENCE_ROOT = priorRoot;
		if (priorState === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = priorState;
		resetWorkspaceRoot();
		for (const dir of [root, stateDir, stateHome]) fs.rmSync(dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		h.wire = mountBlobWire();
		setReferencesEnabled(true);
	});

	afterEach(() => {
		setReferencesEnabled(false);
		h.wire?.dispose();
		h.wire = null;
	});

	describe("the manifest's examples resolve exact, with the lines read off the file", () => {
		it.each([
			["ref://src/cart.ts:Shop:Cart:add", 5, 10],
			["ref://src/cart.ts:Shop:Cart", 2, 11],
			["ref://src/cart.ts:Shop", 1, 12],
			["ref://src/engine.cpp:Physics::World::step", 3, 5],
			["ref://src/engine.cpp:Physics:World:step", 3, 5],
			["ref://src/Svc.cs:Acme.Services:Service:Compute", 4, 6],
			["ref://src/Svc.cs:Acme:Services:Service:Compute", 4, 6],
			["ref://src/belt.gd:Belt:advance", 13, 14],
			["ref://src/belt.gd:Belt:Slot", 4, 6],
			["ref://src/App.tsx:App:render", 2, 2],
			["ref://src/util.js:Outer:deepHandler", 3, 3],
			["ref://src/util.js:Later:deepHandler", 8, 8],
			["ref://src/util.js:deepHandler[2]", 8, 8],
		])("%s is lines %i to %i", async (uri, startLine, endLine) => {
			expect(await keyOf(uri)).toMatchObject({ startLine, endLine, quality: "exact" });
		});

		// The four teaching texts are the contract with the agent; each fixture-backed example must hold.
		it("resolves every fixture-backed example the teaching texts show", async () => {
			const texts = [
				path.join(REPO, "android", "app", "src", "main", "assets", "plugins", "references", "manifest.json"),
				path.join(REPO, "skills", "crosstalk", "SKILL.md"),
				path.join(REPO, "AGENTS.md"),
				path.join(REPO, "src", "mcp", "capabilities.ts"),
			].map((file) => fs.readFileSync(file, "utf8"));
			// Link destinations and backticked forms, so a `]` inside an ordinal stays part of the ref.
			const examples = new Set(
				texts.flatMap((text) => [
					...[...text.matchAll(/\]\((ref:\/\/[^)\s]+)\)/g)].map((m) => m[1] as string),
					...[...text.matchAll(/`<?(ref:\/\/[^`\s>]+)>?`/g)].map((m) => m[1] as string),
				]),
			);
			const fixtureBacked = [...examples].filter((uri) => !/^ref:\/\/(\/|~)/.test(uri));
			expect(fixtureBacked.length).toBeGreaterThan(5);
			for (const uri of fixtureBacked) expect(await keyOf(uri), uri).toMatchObject({ quality: "exact" });
		});

		it("resolves the text forms the teaching shows, a symbol-less file and a region inside a scope", async () => {
			const heading = await keyOf("ref://NOTES.md#Checkout");
			expect(heading).toMatchObject({ startLine: 1, quality: "exact" });
			expect(heading.span).toMatchObject({ startLine: 3 });

			const region = await keyOf("ref://src/cart.ts:Shop:Cart:add#this.items.push(item);");
			expect(region).toMatchObject({ startLine: 5, endLine: 10, quality: "exact" });
			expect(region.span).toMatchObject({ startLine: 6, endLine: 6 });
		});

		it("lights the declaration's name, not the whole scope", async () => {
			const key = await keyOf("ref://src/cart.ts:Shop:Cart:add");
			expect(key.span).toMatchObject({ startLine: 5, endLine: 5 });
			expect(key.span && key.span.endColumn - key.span.startColumn).toBe("add".length);
		});

		it("lights a parameter list for `arguments`, and one parameter after it", async () => {
			const list = await keyOf("ref://src/cart.ts:Shop:Cart:add:arguments");
			expect(list).toMatchObject({ startLine: 5, endLine: 5, quality: "exact" });
			expect(list.span).toMatchObject({ startLine: 5, endLine: 5 });

			const one = await keyOf("ref://src/cart.ts:Shop:Cart:add:arguments:qty");
			expect(one.span && one.span.endColumn - one.span.startColumn).toBe("qty".length);
		});
	});

	describe("what refuses, with the fix to paste", () => {
		it("refuses a name nothing declares, naming what is declared there and the text form", async () => {
			const refused = await refusalOf("ref://src/cart.ts:Shop:Cart:remove");
			expect(refused).toContain('no declaration named "remove"');
			expect(refused).toMatch(/declared there: .*\badd\b/);
			expect(refused).toContain("ref://src/cart.ts#remove");
		});

		it("refuses an ambiguous chain, offering each candidate as a ref that resolves alone", async () => {
			const refused = await refusalOf("ref://src/util.js:deepHandler");
			expect(refused).toContain("2 declarations match");
			const offered = (refused.split("pick one: ")[1] ?? "").split(", ").map((uri) => uri.trim());
			expect(offered).toHaveLength(2);
			for (const uri of offered) expect(await keyOf(uri)).toMatchObject({ quality: "exact" });
		});

		it("picks among repeats with [n] in document order from 1", async () => {
			expect(await keyOf("ref://src/util.js:deepHandler[1]")).toMatchObject({ startLine: 3, quality: "exact" });
			expect(await keyOf("ref://src/util.js:deepHandler[2]")).toMatchObject({ startLine: 8, quality: "exact" });
		});

		it("applies a matcher inside a resolved scope, and refuses a matcher that finds nothing there", async () => {
			const hit = await keyOf("ref://src/cart.ts:Shop:Cart:add#push");
			expect(hit).toMatchObject({ startLine: 5, endLine: 10, quality: "exact" });
			expect(hit.span).toMatchObject({ startLine: 6 });

			const refused = await refusalOf("ref://src/cart.ts:Shop:Cart:add#nowhere");
			expect(refused).toContain('no match for "nowhere"');
			expect(refused).toContain("lines 5-10");
		});

		it("refuses a chain on a path outside the workspace, naming the text form", async () => {
			const refused = await refusalOf("ref:///etc/hostname:host");
			expect(refused).toContain("inside the workspace root");
			expect(refused).toContain("ref:///etc/hostname#host");
		});

		it("refuses a binary file at the file tier", async () => {
			expect(await refusalOf("ref://src/logo.png:foo")).toContain("not text");
		});
	});

	describe("the answer is bound to the file's bytes", () => {
		const cart = () => path.join(root, "src", "cart.ts");
		let original: string;

		beforeEach(() => {
			original = fs.readFileSync(cart(), "utf8");
		});

		afterEach(async () => {
			fs.writeFileSync(cart(), original);
			await session.awaitIndexed("src/cart.ts");
		});

		it("brings the index up when the file changed after it was indexed", async () => {
			const grown = original.replace(/\n\t\}\n\}\n?$/, "\n\t\tclear(): void {}\n\t}\n}\n");
			expect(grown).not.toBe(original);
			fs.writeFileSync(cart(), grown);

			expect(await keyOf("ref://src/cart.ts:Shop:Cart:clear")).toMatchObject({ quality: "exact", startLine: 11 });
		});

		// The file and the index both move between the read and the ask.
		it("reads the file again when it moved under the reply", async () => {
			let moved = false;
			setSessionFactory(async () => ({
				...session,
				resolveChain: async (module: string, segments: string[]) => {
					if (!moved) {
						moved = true;
						fs.writeFileSync(cart(), `// moved\n${original}`);
						await session.awaitIndexed(module);
					}
					return session.resolveChain(module, segments);
				},
			}));
			try {
				const key = await keyOf("ref://src/cart.ts:Shop:Cart:add");
				// The lines describe the moved snapshot.
				expect(key).toMatchObject({ startLine: 6, endLine: 11, quality: "exact" });
			} finally {
				setSessionFactory(async () => session);
			}
		});
	});

	describe("what never touches the daemon", () => {
		it("ships a whole file, or a matcher over it, without a session", async () => {
			setSessionFactory(async () => {
				throw new Error("the daemon must not be asked for a ref with no chain");
			});
			try {
				// Thirteen, since the trailing newline opens a last empty line, as the builder counts it.
				expect(await keyOf("ref://src/cart.ts")).toMatchObject({ startLine: 1, endLine: 13, quality: "exact" });
				const matched = await keyOf("ref://src/cart.ts#reset()");
				expect(matched.span).toMatchObject({ startLine: 8 });
			} finally {
				setSessionFactory(async () => session);
			}
		});

		it("attaches nothing when the message links no refs", async () => {
			expect(await appendRefArtifacts("Just prose, no links.", [])).toEqual({ ok: true, files: [], notices: [] });
		});
	});
});
