// What a working-directory hint means, tested where the rule lives.
//
// Two resolvers answered this differently and neither said which it had used, and which one served a
// call was decided by whether a daemon happened to be running - not by anything the caller could see
// or chose. These drive the shared rule directly, with an injected directory oracle, so no temporary
// tree is needed and every branch is reachable.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyWorkdir, resolveWorkdir, type WorkdirContext, workdirOrFallback } from "../shared/agent-workdir.js";

////////////////////////////////
//  Functions & Helpers

const HOME = "/home/me";
const ROOT = "/home/me/projects";

/** The directories that exist for a case, so a test states its world rather than building one. */
const world = (...dirs: string[]): WorkdirContext => ({
	roots: [ROOT],
	home: HOME,
	isDirectory: (candidate) => dirs.includes(candidate),
});

const resolve = (hint: string | undefined, context: WorkdirContext) => resolveWorkdir(hint, "agentCwd", context);

/**
 * A path carrying one control character, BUILT rather than written.
 *
 * Never a literal in this file. A literal control character is invisible in every viewer, and this
 * is not hypothetical: an earlier draft held one, it rendered as an ordinary space so the assertion
 * beside it looked wrong when it was right, and it turned the file binary so `grep` silently stopped
 * matching anything in it at all.
 */
const withControlChar = (code: number) => `/tmp/a${String.fromCharCode(code)}b`;

const SRC = path.join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

////////////////////////////////
//  Tests

describe("what a hint is", () => {
	it("reads a bare word as a project label", () => {
		expect(classifyWorkdir("recipe-app", "agentCwd", HOME)).toEqual({ kind: "label", value: "recipe-app" });
	});

	it("reads an absolute path as a path", () => {
		expect(classifyWorkdir("/srv/thing", "agentCwd", HOME)).toEqual({ kind: "path", value: "/srv/thing" });
	});

	it("expands a home-rooted path against the home it was given", () => {
		expect(classifyWorkdir("~", "agentCwd", HOME)).toEqual({ kind: "path", value: HOME });
		expect(classifyWorkdir("~/work", "agentCwd", HOME)).toEqual({ kind: "path", value: `${HOME}/work` });
	});

	// The divergence itself. This was a relative path in-process and a label on the daemon, and the
	// relative reading is the one that has to go: it names a different directory depending on where
	// the resolver stands, which is exactly what cannot be allowed to differ.
	it("refuses a relative path rather than resolving it from wherever it stands", () => {
		expect(classifyWorkdir("sub/dir", "agentCwd", HOME)).toMatchObject({ kind: "unsafe", reason: "relative" });
		expect(classifyWorkdir("../up", "agentCwd", HOME)).toMatchObject({ kind: "unsafe", reason: "relative" });
	});

	// The one pair a separator-based label check lets through. `.` under a root resolves to the root
	// itself, so reading it as a label hands back the projects directory as a working directory. An
	// existing daemon test caught this when the first version of the shared classifier missed it.
	it("refuses the two relative paths that hold no separator", () => {
		expect(classifyWorkdir(".", "agentCwd", HOME)).toMatchObject({ kind: "unsafe", reason: "relative" });
		expect(classifyWorkdir("..", "agentCwd", HOME)).toMatchObject({ kind: "unsafe", reason: "relative" });
	});

	// The quoting set, unchanged from what the daemon's own resolver enforced.
	it("refuses the characters a launch command cannot survive", () => {
		for (const bad of ["/tmp/a'b", '/tmp/a"b', "/tmp/a`b", "/tmp/a$b", "/tmp/a\\b"]) {
			expect(classifyWorkdir(bad, "agentCwd", HOME)).toMatchObject({
				kind: "unsafe",
				reason: "forbidden-characters",
			});
		}
	});

	// What the agent path did NOT check before this. It gated only on the cwd belonging to a host
	// session, so a control character reached the resolver while the console's owner-sealed picker
	// refused one through `isWorkdirPath`. 0x01 is a control, 0x7F is delete, 0x200B is a zero-width
	// space - the last is the one a human pasting a path is most likely to carry in by accident.
	it("refuses control characters, which only the console's own validator used to catch", () => {
		for (const code of [0x01, 0x7f, 0x200b]) {
			expect(classifyWorkdir(withControlChar(code), "agentCwd", HOME)).toMatchObject({
				kind: "unsafe",
				reason: "forbidden-characters",
			});
		}
	});

	/**
	 * A space is NOT forbidden, and never was on either resolver.
	 *
	 * Pinned because an earlier draft asserted the opposite and I believed it. A directory with a
	 * space in its name is ordinary, and the quoting hazard is the quote and expansion characters
	 * above, not whitespace.
	 */
	it("allows a space, which is an ordinary character in a directory name", () => {
		expect(classifyWorkdir("/tmp/a b", "agentCwd", HOME)).toEqual({ kind: "path", value: "/tmp/a b" });
	});

	it("treats an absent or whitespace-only hint as naming nothing", () => {
		expect(classifyWorkdir(undefined, "agentCwd", HOME)).toEqual({ kind: "blank" });
		expect(classifyWorkdir("   ", "agentCwd", HOME)).toEqual({ kind: "blank" });
	});
});

describe("resolving a hint", () => {
	it("finds a label under a root", () => {
		expect(resolve("recipe-app", world(`${ROOT}/recipe-app`))).toEqual({
			kind: "resolved",
			path: `${ROOT}/recipe-app`,
		});
	});

	it("takes the first root that holds the label", () => {
		const context: WorkdirContext = {
			roots: ["/a", "/b"],
			home: HOME,
			isDirectory: (candidate) => candidate === "/b/thing",
		};
		expect(resolve("thing", context)).toEqual({ kind: "resolved", path: "/b/thing" });
	});

	it("resolves a root given relative to home", () => {
		const context: WorkdirContext = {
			roots: ["work"],
			home: HOME,
			isDirectory: (candidate) => candidate === `${HOME}/work/thing`,
		};
		expect(resolve("thing", context)).toEqual({ kind: "resolved", path: `${HOME}/work/thing` });
	});

	it("uses an absolute path that is a real directory", () => {
		expect(resolve("/srv/thing", world("/srv/thing"))).toEqual({ kind: "resolved", path: "/srv/thing" });
	});

	// Every unresolved answer names the same fallback, on every path. It used to be home on the daemon
	// and the session's own directory in-process, so an agent handed an unusable hint started work in
	// a different tree depending on which backend served the call.
	it("falls back to home and says why, whatever went wrong", () => {
		expect(resolve(undefined, world())).toEqual({ kind: "unresolved", reason: "blank", fallback: HOME });
		expect(resolve("/nope", world())).toEqual({
			kind: "unresolved",
			reason: "no-such-directory",
			fallback: HOME,
		});
		expect(resolve("nope", world())).toEqual({ kind: "unresolved", reason: "no-such-project", fallback: HOME });
		expect(resolve("a/b", world())).toEqual({ kind: "unresolved", reason: "relative", fallback: HOME });
		expect(resolve("a'b", world())).toEqual({
			kind: "unresolved",
			reason: "forbidden-characters",
			fallback: HOME,
		});
	});

	// A machine with no roots can still use a path; it just cannot look a label up.
	it("resolves no label at all when there are no roots", () => {
		const context: WorkdirContext = { roots: [], home: HOME, isDirectory: () => true };
		expect(resolve("anything", context)).toMatchObject({ kind: "unresolved", reason: "no-such-project" });
		expect(resolve("/anything", context)).toEqual({ kind: "resolved", path: "/anything" });
	});

	it("collapses to a directory for the callers that cannot report a reason yet", () => {
		expect(workdirOrFallback(resolve("recipe-app", world(`${ROOT}/recipe-app`)))).toBe(`${ROOT}/recipe-app`);
		expect(workdirOrFallback(resolve("nope", world()))).toBe(HOME);
	});
});

/**
 * A POSITIVE assertion rather than an absence sweep.
 *
 * The first version here swept for a resolver's shape - statting a path joined onto a base - and it
 * flagged `listHostDirs`, which does that for a completely different reason. Home expansion is no
 * better a signal: six modules do it legitimately, from path validators to `ref://` resolution. A
 * sweep tuned until those pass is a sweep tuned until it catches nothing.
 *
 * So this asserts the delegation instead. It cannot pass vacuously: the two files must exist, and
 * each must actually reach the shared rule.
 */
describe("both bindings delegate", () => {
	const bindings = [
		path.join("mcp", "devcontainer", "hostResolve.ts"),
		path.join("mcp", "local", "localAgentHost.ts"),
	];

	it("the files that used to hold their own resolver are still where this expects them", () => {
		const scanned = new Set(sourceFiles(SRC).map((f) => path.relative(SRC, f)));
		for (const binding of bindings) expect(scanned).toContain(binding);
	});

	it("neither answers a workdir question without going through the shared rule", () => {
		for (const binding of bindings) {
			const body = fs.readFileSync(path.join(SRC, binding), "utf8");
			expect(body, binding).toMatch(/from "\.\.\/\.\.\/shared\/agent-workdir\.js"/);
			expect(body, binding).toMatch(/resolveWorkdir\(/);
		}
	});

	// The Windows resolver is deliberately NOT one of these. It has its own path dialect, its own
	// refusal (a UNC path is refused rather than handed over), and a different home, so folding it in
	// is a decision of its own rather than a rider on this one. Recorded on the board entry.
	it("names the resolver left out on purpose, so its absence is a choice and not an oversight", () => {
		const scanned = new Set(sourceFiles(SRC).map((f) => path.relative(SRC, f)));
		expect(scanned).toContain(path.join("mcp", "devcontainer", "windowsSpawn.ts"));
	});
});
