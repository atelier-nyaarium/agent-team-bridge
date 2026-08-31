import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC = path.join(REPO_ROOT, "src");

/** The port a double stands in for. */
const IMPLEMENTS = /implements\s+AppServerSession/;

/** Named as the port names it, so a double that dropped the parameter is visible here. */
const REGISTERS = /onStarted\s*\(/;

////////////////////////////////
//  Functions & Helpers

function strip(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function doubles(): Array<{ file: string; source: string }> {
	const out: Array<{ file: string; source: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts")) {
				const source = strip(fs.readFileSync(full, "utf8"));
				if (IMPLEMENTS.test(source)) out.push({ file: full, source });
			}
		}
	};
	walk(SRC);
	return out;
}

function offenders(sources: Array<{ file: string; source: string }>): string[] {
	return sources.filter(({ source }) => !REGISTERS.test(source)).map(({ file }) => path.relative(REPO_ROOT, file));
}

////////////////////////////////
//  Tests

describe("a double of AppServerSession models the registration callback", () => {
	const swept = doubles();

	it("finds the doubles it sweeps", () => {
		expect(swept.length).toBeGreaterThanOrEqual(1);
	});

	it("has every double naming onStarted", () => {
		expect(
			offenders(swept),
			"a double must take the port's onStarted and CALL it, or it proves a path the client cannot take",
		).toEqual([]);
	});

	it("recognises a silent double when planted, through the same stripping the sweep uses", () => {
		const planted = [
			{
				file: "good.ts",
				source: `class F implements AppServerSession { startTurn(t, x, onStarted) { onStarted(id); } }`,
			},
			{ file: "bad.ts", source: `class F implements AppServerSession { startTurn(t, x) {} }` },
			{
				file: "took.ts",
				source: `class F implements AppServerSession { startTurn(t, x, onStarted) { return id; } }`,
			},
			{ file: "commented.ts", source: `class F implements AppServerSession {} // onStarted(id)` },
		].map((p) => ({ ...p, source: strip(p.source) }));
		expect(offenders(planted)).toEqual(["bad.ts", "took.ts", "commented.ts"]);
	});
});
