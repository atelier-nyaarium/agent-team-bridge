import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TESTS = path.join(REPO_ROOT, "src", "__tests__");

/** The one deliberate direct send per service: a refusal carries no generation, so it is not fenced. */
const ALLOWED_DIRECT_SENDS = 1;

const CONSUMER = /new AgentDaemonCore/;

/** Narrower than `.send(`, which every transport and socket also spells. */
const DIRECT_SEND = /\bdeps\.send\(/g;

////////////////////////////////
//  Functions & Helpers

/** Comments removed, so a call named in prose is not counted as one. */
function strip(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function consumers(): Array<{ file: string; source: string }> {
	const out: Array<{ file: string; source: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full !== TESTS) walk(full);
			} else if (entry.name.endsWith(".ts")) {
				const source = strip(fs.readFileSync(full, "utf8"));
				if (CONSUMER.test(source)) out.push({ file: full, source });
			}
		}
	};
	walk(path.join(REPO_ROOT, "src"));
	return out;
}

function directSends(source: string): number {
	return source.match(DIRECT_SEND)?.length ?? 0;
}

function offenders(sources: Array<{ file: string; source: string }>): string[] {
	return sources
		.filter(({ source }) => directSends(source) > ALLOWED_DIRECT_SENDS)
		.map(({ file }) => path.relative(REPO_ROOT, file));
}

////////////////////////////////
//  Tests

describe("a daemon frame carrying a generation goes out through the fence", () => {
	const swept = consumers();

	it("sweeps every service built on the core", () => {
		expect(swept.length).toBeGreaterThanOrEqual(2);
	});

	it("has nobody sending a second frame past AgentDaemonCore.publish", () => {
		expect(
			offenders(swept),
			"publish refuses a retired generation; a direct send is fenceless and only a refusal may be",
		).toEqual([]);
	});

	it("recognises a second direct send when planted, through the same stripping the sweep uses", () => {
		const planted = [
			{ file: "one.ts", source: `new AgentDaemonCore(); this.deps.send(a);` },
			{ file: "two.ts", source: `new AgentDaemonCore(); this.deps.send(a); this.deps.send(b);` },
			{ file: "three.ts", source: `new AgentDaemonCore(); this.deps.send(a); // this.deps.send(b)` },
		].map((p) => ({ ...p, source: strip(p.source) }));
		expect(offenders(planted)).toEqual(["two.ts"]);
	});
});
