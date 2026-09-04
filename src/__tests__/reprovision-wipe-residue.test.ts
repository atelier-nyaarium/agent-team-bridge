import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * Source-residue guard for the Clear-and-re-provision wipe: declaring `ClearsOnReprovision` does
 * nothing until the roster names the field, and reading that roster needs an instance, so a Context.
 *
 * In the TS suite on purpose: the Android tests run after merge and could not block the PR.
 */
const ANDROID_SRC = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

const REPOSITORY = path.join(ANDROID_SRC, "ChatRepository.kt");

function kotlinSources(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinSources(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** Supertypes, constructor parens skipped. */
function supertypesOf(source: string, from: number): string {
	let depth = 0;
	let out = "";
	for (let i = from; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") depth -= 1;
		else if (depth === 0 && ch === "{") break;
		else if (depth === 0) out += ch;
	}
	return out;
}

/** Every class declaring its own wipe, by name. */
function wipingClasses(): Set<string> {
	const out = new Set<string>();
	for (const file of kotlinSources(ANDROID_SRC)) {
		const source = fs.readFileSync(file, "utf8");
		for (const m of source.matchAll(/^(?:@\w+(?:\([^)]*\))? )*(?:\w+ )*class (\w+)/gm)) {
			const header = supertypesOf(source, (m.index ?? 0) + m[0].length);
			if (m[1] && /:\s*ClearsOnReprovision\b/.test(header)) out.add(m[1]);
		}
	}
	return out;
}

/** The repository's own fields, as `name` -> the class its initializer constructs. */
function repositoryFields(): Map<string, string> {
	const source = fs.readFileSync(REPOSITORY, "utf8");
	const fields = new Map<string, string>();
	// Any visibility: `board` is a plain `val`, and a modifier-specific scan would silently skip it.
	for (const m of source.matchAll(/^\t(?:\w+ )*val (\w+) = (?:[\w.]*\.)?(\w+)\(/gm)) {
		if (m[1] && m[2]) fields.set(m[1], m[2]);
	}
	return fields;
}

/** The names the roster lists, minus `this`. */
function rosterNames(): string[] {
	const source = fs.readFileSync(REPOSITORY, "utf8");
	const listed = source.match(/get\(\) = listOf\(([^)]*)\)/);
	if (!listed?.[1]) throw new Error("clearedOnReprovision's roster is no longer a listOf(...) literal");
	return listed[1]
		.split(",")
		.map((n) => n.trim())
		.filter((n) => n !== "this");
}

////////////////////////////////
//  Tests

describe("a re-provision wipes every holder that declares a wipe", () => {
	it("the roster names every repository field whose type clears itself", () => {
		const wiping = wipingClasses();
		const shouldBeListed = [...repositoryFields()]
			.filter(([, type]) => wiping.has(type))
			.map(([name]) => name)
			.sort();

		expect(rosterNames().sort()).toEqual(shouldBeListed);
	});

	it("finds classes and fields at all, so the comparison above is proving something", () => {
		// Both sides empty would satisfy the assertion above while checking nothing.
		expect(wipingClasses().size).toBeGreaterThan(0);
		expect(rosterNames().length).toBeGreaterThan(0);
	});
});
