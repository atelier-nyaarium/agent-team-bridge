import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { tryParseRef } from "../mcp/references/refGrammar.js";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(root, "tests/fixtures/ref-project");
const texts = [
	fs.readFileSync(path.join(root, "android/app/src/main/assets/plugins/references/manifest.json"), "utf8"),
	fs.readFileSync(path.join(root, "skills/crosstalk/SKILL.md"), "utf8"),
	fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"),
	fs.readFileSync(path.join(root, "src/mcp/capabilities.ts"), "utf8"),
];

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
});
