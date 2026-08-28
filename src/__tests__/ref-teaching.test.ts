import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { tryParseRef } from "../mcp/references/refGrammar.js";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(root, "tests/fixtures/ref-project");
const SURFACES = [
	"android/app/src/main/assets/plugins/references/manifest.json",
	"skills/crosstalk/SKILL.md",
	"CLAUDE.md",
	"src/mcp/capabilities.ts",
] as const;
// Unescaped, so a template literal's \` reads as the backtick an agent is shown.
const texts = SURFACES.map((surface) => fs.readFileSync(path.join(root, surface), "utf8").replaceAll("\\`", "`"));

/** How each matcher the grammar accepts is spelled where refs are taught. */
const SPELLINGS: Record<string, string> = {
	text: "`#text`",
	before: "@before:",
	after: "@after:",
	range: "`#from..to`",
};

/** The kinds of `Matcher`, read from the union so a new one arrives here untaught. */
function matcherKinds(): string[] {
	const source = fs.readFileSync(path.join(root, "src/mcp/references/refGrammar.ts"), "utf8");
	const union = /export type Matcher =([\s\S]*?)\};/.exec(source);
	if (union === null) throw new Error("the Matcher union moved");
	return [...union[1].matchAll(/kind: "(\w+)"/g)].map((match) => match[1]);
}

function refsIn(text: string): string[] {
	const refs = new Set<string>();
	for (const match of text.matchAll(/\]\(<(ref:\/\/[^>]+)>\)/g)) refs.add(match[1]);
	for (const match of text.matchAll(/\]\((ref:\/\/[^)\s]+)\)/g)) refs.add(match[1]);
	for (const match of text.matchAll(/`(ref:\/\/[^`]+)`/g)) refs.add(match[1]);
	return [...refs];
}

describe("ref teaching", () => {
	test("contains parseable examples", () => {
		const examples = texts.flatMap(refsIn);
		expect(examples.length).toBeGreaterThan(0);
		for (const example of examples) expect(tryParseRef(example), example).toMatchObject({ kind: "ok" });
	});

	test("uses existing fixture paths for root-relative examples", () => {
		const examples = texts.flatMap(refsIn);
		const paths = examples
			.map((example) => tryParseRef(example))
			.filter((result): result is Extract<typeof result, { kind: "ok" }> => result.kind === "ok")
			.map(({ ref }) => ref.path)
			.filter((refPath) => !refPath.startsWith("/") && !refPath.startsWith("~/"));
		expect(paths.length).toBeGreaterThan(0);
		for (const refPath of paths) expect(fs.existsSync(path.join(fixtureRoot, refPath)), refPath).toBe(true);
	});

	test("teaches every matcher the grammar accepts, on every surface", () => {
		const kinds = matcherKinds();
		expect(kinds).toContain("text");
		expect(kinds.length).toBeGreaterThan(3);
		for (const kind of kinds) {
			const spelling = SPELLINGS[kind];
			expect(spelling, `no documented spelling for matcher ${kind}`).toBeDefined();
			for (const [index, surface] of SURFACES.entries()) {
				expect(texts[index].includes(spelling), `${surface} does not teach ${kind}`).toBe(true);
			}
		}
	});
});
