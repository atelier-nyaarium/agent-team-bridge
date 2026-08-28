import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

const REFERENCES = path.join(import.meta.dirname, "..", "mcp", "references");
const SRC = path.join(import.meta.dirname, "..");

/** The narrowest token that only the owner may hold, with the violation each rule is proven to catch. */
const OWNED: Array<{ token: RegExp; owner: string; what: string; plant: string }> = [
	{ token: /\bos\.homedir\(/, owner: "refWorkspace.ts", what: "the home directory", plant: "os.homedir()" },
	{ token: /\brealpath/, owner: "refWorkspace.ts", what: "a real path", plant: "fs.realpathSync(x)" },
	{ token: /\bpath\.resolve\(/, owner: "refWorkspace.ts", what: "path resolution", plant: "path.resolve(a, b)" },
	{ token: /\bfunction lineOf\(/, owner: "refCoordinates.ts", what: "line arithmetic", plant: "function lineOf(t)" },
	{
		token: /\bfunction columnOf\(/,
		owner: "refCoordinates.ts",
		what: "column arithmetic",
		plant: "function columnOf(t)",
	},
];

function sources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

////////////////////////////////
//  Tests

describe("what only one references module may do", () => {
	const files = sources(REFERENCES);

	it("found the references modules to sweep", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	for (const rule of OWNED) {
		it(`fires on a planted use of ${rule.what}, and sees the owner hold it`, () => {
			expect(rule.token.test(rule.plant)).toBe(true);
			expect(rule.token.test(fs.readFileSync(path.join(REFERENCES, rule.owner), "utf8"))).toBe(true);
		});

		it(`keeps ${rule.what} in ${rule.owner}`, () => {
			const offenders = files
				.filter((file) => path.basename(file) !== rule.owner)
				.filter((file) => rule.token.test(fs.readFileSync(file, "utf8")))
				.map((file) => path.relative(SRC, file));
			expect(offenders).toEqual([]);
		});
	}

	it("has retired referenceRoot and the tree-sitter resolver everywhere under src", () => {
		const offenders = sources(SRC)
			.filter((file) => /\breferenceRoot\b|web-tree-sitter|grammarSources/.test(fs.readFileSync(file, "utf8")))
			.map((file) => path.relative(SRC, file));
		expect(offenders).toEqual([]);
	});
});
