import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { GRAMMAR_SOURCES, grammarForPath, grammarWasmPath, MANIFEST_FILE } from "../mcp/references/grammarSources.js";

////////////////////////////////
//  Functions & Helpers

/** A snippet per grammar, each declaring a scope the resolver will later need to walk into. */
const SNIPPETS: Record<string, string> = {
	typescript: "namespace A { export class B { method(url: string): void {} } }",
	tsx: "export const App = () => <div className={x}>{y}</div>;",
	javascript: "class B { method(url) { return url; } }",
	cpp: "namespace A { namespace B { void method(const char* url) {} } }",
	c_sharp: "namespace A.B { class C { void Method(string url) {} } }",
	python: "class B:\n\tdef method(self, url):\n\t\treturn url\n",
	gdscript: "class_name B\n\nfunc method(url):\n\treturn url\n",
};

async function parserFor(id: string): Promise<Parser> {
	await Parser.init();
	const parser = new Parser();
	parser.setLanguage(await Language.load(grammarWasmPath(id)));
	return parser;
}

////////////////////////////////
//  Tests

describe("the committed grammars", () => {
	// This suite is the guard on a Dependabot bump: web-tree-sitter will not load a wasm built by a
	// mismatched CLI, and nothing else in the build would notice. A failure here means rerunning
	// `bun scripts/build-grammars.ts` and committing the result.
	it.each(GRAMMAR_SOURCES.map((s) => s.id))("parses %s without erroring", async (id) => {
		const parser = await parserFor(id);
		const tree = parser.parse(SNIPPETS[id]);

		expect(tree).not.toBeNull();
		expect(tree?.rootNode.hasError).toBe(false);
	});

	it("records the toolchain that produced them, since a wasm cannot be asked", () => {
		const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));

		expect(manifest.treeSitterCli).toBe(manifest.webTreeSitter);
		expect(Object.keys(manifest.grammars).sort()).toEqual(GRAMMAR_SOURCES.map((s) => s.id).sort());
	});

	it("ships a wasm for every source it declares", () => {
		const missing = GRAMMAR_SOURCES.filter((s) => !fs.existsSync(grammarWasmPath(s.id)));

		expect(missing.map((s) => s.id)).toEqual([]);
	});
});

describe("grammarForPath", () => {
	it("routes tsx to its own grammar, which plain TypeScript cannot parse", () => {
		expect(grammarForPath("src/App.tsx")).toBe("tsx");
		expect(grammarForPath("src/app.ts")).toBe("typescript");
	});

	it("names a grammar for each language the plan whitelists", () => {
		const routed = ["a.ts", "a.tsx", "a.js", "a.cpp", "a.cs", "a.py", "a.gd"].map(grammarForPath);

		expect(routed).toEqual(["typescript", "tsx", "javascript", "cpp", "c_sharp", "python", "gdscript"]);
	});

	it("declines a file no whitelisted grammar parses, rather than guessing one", () => {
		expect(grammarForPath("README.md")).toBeNull();
		expect(grammarForPath("Makefile")).toBeNull();
	});
});
