import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The transport, whose module-private failure class is the one minter; the compiler holds that. */
const OWNER = path.join(REPO_ROOT, "src", "mcp", "devcontainer", "codexAppServer.ts");

const TESTS = path.join(REPO_ROOT, "src", "__tests__");

/** The Copilot transport mints its own timeout sentence; a minter is not a branch. */
const COPILOT_TRANSPORT = path.join(REPO_ROOT, "src", "mcp", "devcontainer", "copilotAcp.ts");

/** The transport's own sentences, by the fragment each carries. */
const TRANSPORT_FRAGMENTS = ["timed out:", "unreadable response", "app server exited"];

/** The App Server's lifecycle refusals, by the fragment only those sentences carry. */
const LIFECYCLE_FRAGMENTS = ["codex unarchive", "rollout found for thread id"];

/** Refusals recorded from codex-cli 0.147.0, so the fragments are held to the real wording. */
const RECORDED_REFUSALS = [
	"session 01a05505-0927-7790-8243-4aa557c2eeb8 is archived. Run `codex unarchive 01a05505-0927-7790-8243-4aa557c2eeb8` to unarchive it first.",
	"no rollout found for thread id 01a05504-4805-7110-b4fe-81ccefec73b2",
	"no archived rollout found for thread id 01a05516-3565-7482-99da-b305c60fde26",
];

/** Any code context is a branch on prose; `AppServerFailure.kind` is the discriminator. */
const SENTENCE = new RegExp([...TRANSPORT_FRAGMENTS, ...LIFECYCLE_FRAGMENTS].join("|"));

////////////////////////////////
//  Functions & Helpers

/** Comments removed, so a sentence quoted in prose is not read as a branch. */
function strip(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function code(file: string): string {
	return strip(fs.readFileSync(file, "utf8"));
}

/** Every production TypeScript source under src/ but the two transports. */
function sweptSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full !== TESTS) walk(full);
			} else if (entry.name.endsWith(".ts") && full !== OWNER && full !== COPILOT_TRANSPORT) out.push(full);
		}
	};
	walk(path.join(REPO_ROOT, "src"));
	return out;
}

function offenders(sources: Array<{ file: string; source: string }>): string[] {
	return sources.filter(({ source }) => SENTENCE.test(source)).map(({ file }) => path.relative(REPO_ROOT, file));
}

////////////////////////////////
//  Tests

describe("no branch on an App Server failure's sentence", () => {
	const swept = sweptSources().map((file) => ({ file, source: code(file) }));

	it("sweeps the tree, and the owner carries each transport fragment it forbids elsewhere", () => {
		expect(swept.length).toBeGreaterThan(50);
		const owner = code(OWNER);
		for (const fragment of TRANSPORT_FRAGMENTS) expect(owner, fragment).toContain(fragment);
	});

	it("holds each lifecycle fragment to a refusal the App Server actually sent", () => {
		for (const refusal of RECORDED_REFUSALS) expect(SENTENCE.test(refusal), refusal).toBe(true);
		for (const fragment of LIFECYCLE_FRAGMENTS) {
			expect(
				RECORDED_REFUSALS.some((refusal) => refusal.includes(fragment)),
				fragment,
			).toBe(true);
		}
	});

	it("has nobody branching on a failure's sentence", () => {
		expect(
			offenders(swept),
			"a request failure is classified by AppServerFailure.kind, never by its wording",
		).toEqual([]);
	});

	it("recognises each forbidden shape when planted, through the same stripping the sweep uses", () => {
		const planted = [
			{ file: "a.ts", source: `if (error.message.includes("codex unarchive")) retry();` },
			{ file: "b.ts", source: `const stale = /rollout found for thread id/.test(reason);` },
			{ file: "c.ts", source: "const dead = `app server exited`;" },
			{ file: "d.ts", source: `throw new Error("timed out: archive");` },
			{ file: "e.ts", source: `// prose: app server exited\nconst fine = 1;` },
			{ file: "f.ts", source: `/* prose: no rollout found for thread id */\nconst fine = 1;` },
		].map((p) => ({ ...p, source: strip(p.source) }));
		expect(offenders(planted)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
	});
});
