import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEVCONTAINER = path.join(REPO_ROOT, "src", "mcp", "devcontainer");

/** The one module that may hold how long a turn has been silent. */
const OWNER = path.join(DEVCONTAINER, "codexLiveTurns.ts");

/** A turn's watchdog state, by the term only its owner has reason to write. */
const LIVENESS = /\bstrikes\b/;

////////////////////////////////
//  Functions & Helpers

/** Comments and string bodies removed, so a term named in either is not counted. */
function strip(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function swept(): Array<{ file: string; source: string }> {
	return fs
		.readdirSync(DEVCONTAINER, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.join(DEVCONTAINER, entry.name))
		.filter((file) => file !== OWNER)
		.map((file) => ({ file, source: strip(fs.readFileSync(file, "utf8")) }));
}

function offenders(sources: Array<{ file: string; source: string }>): string[] {
	return sources.filter(({ source }) => LIVENESS.test(source)).map(({ file }) => path.relative(REPO_ROOT, file));
}

////////////////////////////////
//  Tests

describe("how long a turn has been silent lives with the turn", () => {
	const sources = swept();

	it("sweeps the devcontainer modules, and the owner carries what it forbids elsewhere", () => {
		expect(sources.length).toBeGreaterThan(5);
		expect(strip(fs.readFileSync(OWNER, "utf8"))).toMatch(LIVENESS);
	});

	it("has nobody else keeping a turn's watchdog state", () => {
		expect(
			offenders(sources),
			"a clock kept apart from the turn it measures is how another thread's frame refreshed it",
		).toEqual([]);
	});

	it("recognises the forbidden shape when planted, through the same stripping the sweep uses", () => {
		const planted = [
			{ file: "a.ts", source: `const watch = new Map<string, { at: number; strikes: number }>();` },
			{ file: "b.ts", source: `if (seen.strikes === 0) interrupt();` },
			{ file: "c.ts", source: `// strikes are counted elsewhere\nconst fine = 1;` },
			{ file: "d.ts", source: `const note = "strikes";` },
		].map((p) => ({ ...p, source: strip(p.source) }));
		expect(offenders(planted)).toEqual(["a.ts", "b.ts"]);
	});
});
