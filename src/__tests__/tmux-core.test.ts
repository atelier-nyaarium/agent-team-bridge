import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture every spawned argv and simulate a clean (or failing) child, so we can assert
// the exact tmux command shapes without a real tmux/docker.
const calls: string[][] = [];
let exitCode = 0;
// Per-spawn exit codes consumed in order; falls back to the global exitCode when empty. Lets a test
// drive a multi-spawn sequence (e.g. has-session fails, then new-session succeeds).
const exitQueue: number[] = [];
let stdoutData = "";
// Scripted stderr emitted on a non-zero exit, so a test can drive the exact failure wording
// killSession classifies on (e.g. tmux's "can't find session" vs an unrecognized failure).
let stderrData = "";
// Scripted stderr for a `docker logs` spawn, emitted regardless of exit code (docker sends a
// container's stderr there on a clean run). Lets a test drive the mergeStderr fold.
let logsStderr = "";

vi.mock("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		const code = exitQueue.length ? (exitQueue.shift() as number) : exitCode;
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: () => void;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		// Only a capture-pane returns a screen; a send-keys / has-session / etc. has no stdout, so a
		// scripted screen is not consumed by the "1" keypresses awaitReady interleaves with its peeks.
		const out = args.includes("capture-pane") || args.includes("logs") ? stdoutData : "";
		queueMicrotask(() => {
			if (out) child.stdout.emit("data", Buffer.from(out));
			if (args.includes("logs") && logsStderr) child.stderr.emit("data", Buffer.from(logsStderr));
			if (code !== 0 && stderrData) child.stderr.emit("data", Buffer.from(stderrData));
			child.emit("close", code);
		});
		return child;
	},
}));

import {
	awaitReady,
	createSession,
	ensureSession,
	hasSession,
	isAgentReady,
	isAgentWorking,
	isAtPrompt,
	isLoggedOut,
	killSession,
	peekPane,
	peekWithFallback,
	selfSessionTarget,
	sendKey,
	sendText,
} from "../mcp/devcontainer/tmuxCore.js";
import type { TmuxTarget } from "../shared/host-op.js";
import { DEFAULT_SESSION } from "../shared/session-id.js";

afterEach(() => {
	calls.length = 0;
	exitCode = 0;
	exitQueue.length = 0;
	stdoutData = "";
	stderrData = "";
	logsStderr = "";
});

describe("tmuxCore sendText", () => {
	it("types text + a trailing CR atomically in one send-keys, with -- guarding a leading dash", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "-l hello");
		// One invocation: the CR (the Enter key) rides inside the literal so text and submission
		// cannot be torn apart by a failure between two commands.
		expect(calls).toEqual([["tmux", "send-keys", "-t", "=claude.0", "-l", "--", "-l hello\r"]]);
	});

	it("omits the trailing CR when submit is false (types into the composer without submitting)", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "hello", false);
		expect(calls).toEqual([["tmux", "send-keys", "-t", "=claude.0", "-l", "--", "hello"]]);
	});

	it("targets a devcontainer via docker exec by the compose container name", async () => {
		await sendText({ kind: "devcontainer", name: "recipe-app", sessionName: "claude" }, "hi");
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"send-keys",
			"-t",
			"=claude.0",
			"-l",
			"--",
			"hi\r",
		]);
	});

	it("refuses to inject text into a reserved host session without spawning anything", async () => {
		await expect(sendText({ kind: "host", name: "host", sessionName: "host-daemon" }, "hi")).rejects.toThrow(
			/reserved host session/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore sendKey", () => {
	it("sends an allowed control key with no -l and no trailing Enter", async () => {
		await sendKey({ kind: "host", name: "host", sessionName: "claude" }, "C-c");
		expect(calls).toEqual([["tmux", "send-keys", "-t", "=claude.0", "C-c"]]);
	});

	it("rejects a key not on the whitelist without spawning anything", async () => {
		await expect(sendKey({ kind: "host", name: "host", sessionName: "claude" }, "rm -rf")).rejects.toThrow(
			/disallowed key/,
		);
		expect(calls).toHaveLength(0);
	});

	it("refuses a control key to a reserved host session without spawning anything", async () => {
		await expect(sendKey({ kind: "host", name: "host", sessionName: "host-daemon" }, "C-c")).rejects.toThrow(
			/reserved host session/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore peekPane", () => {
	it("resizes the detached session to fit the phone, then captures the visible pane with a hash", async () => {
		stdoutData = "screen contents";
		const r = await peekPane({ kind: "host", name: "host", sessionName: "claude" });
		expect(calls[0]).toEqual(["tmux", "resize-window", "-t", "=claude", "-x", "58", "-y", "40"]);
		expect(calls[1]).toEqual(["tmux", "capture-pane", "-t", "=claude.0", "-e", "-p"]);
		expect(r.ansi).toBe("screen contents");
		expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("rejects a target name that is not a slug before reaching docker", async () => {
		await expect(peekPane({ kind: "devcontainer", name: "x;y", sessionName: "claude" })).rejects.toThrow(
			/invalid tmux name/,
		);
		expect(calls).toHaveLength(0);
	});

	it("rejects a crafted session name before reaching tmux", async () => {
		await expect(peekPane({ kind: "host", name: "host", sessionName: "a;b" })).rejects.toThrow(/invalid tmux name/);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore peekWithFallback", () => {
	const dev: TmuxTarget = { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" };

	it("returns the tmux pane tagged kind:tmux when the pane exists", async () => {
		stdoutData = "PANE";
		const r = await peekWithFallback(dev);
		expect(r).toMatchObject({ kind: "tmux", ansi: "PANE" });
	});

	it("falls back to container logs (kind:container-logs) when the pane is absent", async () => {
		stdoutData = "postCreate installing deps";
		stderrData = "can't find session";
		// resize (ok), capture-pane (absent), then docker logs (ok).
		exitQueue.push(0, 1, 0);
		const r = await peekWithFallback(dev);
		expect(r.kind).toBe("container-logs");
		if (r.kind === "container-logs") expect(r.text).toBe("postCreate installing deps");
		// The tail count + compose container-name convention reach docker verbatim.
		expect(calls.find((c) => c.includes("logs"))).toEqual([
			"docker",
			"logs",
			"--tail",
			"200",
			"recipe-app_devcontainer-dev-1",
		]);
	});

	it("folds a container's stderr into the log text so a boot error is not lost", async () => {
		stdoutData = "starting";
		stderrData = "can't find session";
		logsStderr = "postCreate.sh: line 3: npm: command not found";
		exitQueue.push(0, 1, 0); // resize ok, capture absent, docker logs ok
		const r = await peekWithFallback(dev);
		expect(r.kind).toBe("container-logs");
		if (r.kind === "container-logs") {
			expect(r.text).toContain("starting");
			expect(r.text).toContain("command not found");
		}
	});

	it("rethrows a real failure without trying container logs", async () => {
		stderrData = "tmux command exited 2";
		exitQueue.push(0, 1); // resize ok, capture a non-absent failure
		await expect(peekWithFallback(dev)).rejects.toThrow(/exited 2/);
		expect(calls.some((c) => c.includes("logs"))).toBe(false);
	});

	it("rethrows the original absent peek error when the container is also gone", async () => {
		stderrData = "can't find session";
		exitQueue.push(0, 1, 1); // resize ok, capture absent, docker logs also fails
		await expect(peekWithFallback(dev)).rejects.toThrow(/can't find session/);
	});
});

describe("tmuxCore createSession", () => {
	it("creates a detached session by name on the host running the command", async () => {
		await createSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude --foo");
		expect(calls).toEqual([["tmux", "new-session", "-d", "-s", "scratch", "claude --foo"]]);
	});

	it("creates a session inside a devcontainer via docker exec", async () => {
		await createSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" }, "claude");
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"new-session",
			"-d",
			"-s",
			"scratch",
			"claude",
		]);
	});

	it("rejects a crafted session name before spawning anything", async () => {
		await expect(createSession({ kind: "host", name: "host", sessionName: "a;b" }, "claude")).rejects.toThrow(
			/invalid tmux name/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore hasSession / ensureSession", () => {
	it("hasSession is true when has-session exits 0", async () => {
		const alive = await hasSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" });
		expect(alive).toBe(true);
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"has-session",
			"-t",
			"=scratch",
		]);
	});

	it("hasSession is false when has-session exits non-zero (absent, not an error)", async () => {
		exitCode = 1;
		expect(await hasSession({ kind: "host", name: "host", sessionName: "scratch" })).toBe(false);
	});

	it("ensureSession reattaches an existing session without launching a new one", async () => {
		exitCode = 0; // has-session succeeds
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: false });
		expect(calls).toHaveLength(1); // only has-session, no new-session
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=scratch"]);
	});

	it("ensureSession launches a fresh session when absent", async () => {
		exitQueue.push(1, 0); // has-session absent, then new-session succeeds
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: true });
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=scratch"]);
		expect(calls[1]).toEqual(["tmux", "new-session", "-d", "-s", "scratch", "claude"]);
		expect(calls).toHaveLength(2);
	});

	it("ensureSession treats a duplicate (lost race) as a reattach when the session now exists", async () => {
		// has-session misses (absent or transient), new-session loses a race / errors duplicate, then
		// the re-check finds the session present.
		exitQueue.push(1, 1, 0);
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: false });
		expect(calls).toHaveLength(3); // has-session, new-session, re-check has-session
	});

	it("ensureSession surfaces the failure when the session is still absent after a failed create", async () => {
		exitQueue.push(1, 1, 1); // absent, create fails, still absent
		await expect(ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude")).rejects.toThrow();
	});
});

describe("tmuxCore isAgentReady", () => {
	it("is false for an empty or still-booting pane", () => {
		expect(isAgentReady("")).toBe(false);
		expect(isAgentReady("Loading development channels...")).toBe(false);
	});

	it("is false at an indented menu cursor (a launch menu, not the composer)", () => {
		expect(isAgentReady("  ❯ 1. I am using this for local development\n    2. Exit")).toBe(false);
	});

	it("is true at the column-0 composer prompt (fresh idle REPL)", () => {
		expect(isAgentReady("❯ ")).toBe(true);
	});

	it("is true at a resumed REPL whose header scrolled off (composer still shows)", () => {
		expect(isAgentReady("...restored conversation...\n❯ ")).toBe(true);
	});

	it("sees the composer through the SGR escapes a real -e capture prefixes it with", () => {
		// capture-pane -e renders the composer line as e.g. "\e[39m❯ \e[2mTry\e[0m".
		const esc = String.fromCharCode(27);
		expect(isAgentReady(`${esc}[39m❯ ${esc}[2mTry${esc}[0m`)).toBe(true);
	});
});

describe("tmuxCore killSession", () => {
	it("kills the target session by name", async () => {
		await killSession({ kind: "host", name: "host", sessionName: "scratch" });
		expect(calls).toEqual([["tmux", "kill-session", "-t", "=scratch"]]);
	});

	it("kills a devcontainer session via docker exec", async () => {
		await killSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" });
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"kill-session",
			"-t",
			"=scratch",
		]);
	});

	it("treats an already-gone session as success (swallows the absent error)", async () => {
		exitCode = 1; // kill-session exits non-zero when the session is absent
		stderrData = "can't find session: scratch";
		await expect(killSession({ kind: "host", name: "host", sessionName: "scratch" })).resolves.toBeUndefined();
	});

	it("rethrows when the kill is unconfirmed (not a recognized absent error)", async () => {
		// A timeout or unrecognized exit means the kill is unconfirmed; rethrow so a forget does not
		// drop the resume record over a still-live tmux. The generic non-zero exit classifies as a
		// failure (no absent stderr), the conservative default.
		exitCode = 1;
		await expect(killSession({ kind: "host", name: "host", sessionName: "scratch" })).rejects.toThrow();
	});
});

describe("tmuxCore isAgentWorking", () => {
	it("is working when the esc-to-interrupt hint is on the last line", () => {
		expect(isAgentWorking("✻ Prestidigitating… (12s · esc to interrupt)")).toBe(true);
		expect(isAgentWorking("✻ Brewed for 7s")).toBe(false);
		expect(isAgentWorking("")).toBe(false);
		expect(isAgentWorking("❯ ")).toBe(false);
	});

	it("can land on either of the last two lines depending on how the pane wraps", () => {
		expect(isAgentWorking("✻ Prestidigitating…\n(12s · esc to interrupt)")).toBe(true);
		expect(isAgentWorking("(12s · esc to interrupt)\n✻ Prestidigitating…")).toBe(true);
	});

	it("ignores a hint more than two lines back when there is no rule to bound the search by", () => {
		expect(isAgentWorking("(12s · esc to interrupt)\n✻ Prestidigitating…\n❯ ")).toBe(false);
	});

	it("finds the hint any distance below the rule, since the footer's height is dynamic", () => {
		const rule = "─".repeat(40);
		// 3 lines above the very bottom - past the old fixed "last 2 lines" heuristic - but below the
		// rule, so the properly-bounded footer search still finds it.
		expect(
			isAgentWorking(
				`❯ \n${rule}\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on\n  ← for agents`,
			),
		).toBe(true);
		// A hint ABOVE the rule is transcript/history, not the live footer - never counts, even when
		// it would fall within some arbitrary distance of the bottom.
		expect(isAgentWorking(`✻ Prestidigitating… (12s · esc to interrupt)\n${rule}\n❯ `)).toBe(false);
	});

	it("strips the SGR escapes around the hint", () => {
		const esc = String.fromCharCode(27);
		expect(isAgentWorking(`✻ Prestidigitating${esc}[2m… (12s ${esc}[2m·${esc}[0m esc to interrupt)${esc}[0m`)).toBe(
			true,
		);
	});

	it("also counts a task-bullet marker (◯) in the footer, same as the esc hint", () => {
		const rule = "─".repeat(40);
		expect(isAgentWorking(`❯ \n${rule}\n  ◯ idle-pushback`)).toBe(true);
		// Above the rule is transcript/history (e.g. a completed todo list), not the live footer.
		expect(isAgentWorking(`  ◯ idle-pushback\n${rule}\n❯ `)).toBe(false);
	});
});

describe("tmuxCore isLoggedOut", () => {
	const rule = "─".repeat(40);

	it("is true when the toolbar below the last rule shows the auth footer", () => {
		const screen = `❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents    Not logged in · Run /login\n  ◐ medium · /effort`;
		expect(isLoggedOut(screen)).toBe(true);
	});

	it("is false at a logged-in REPL (no auth footer in the toolbar)", () => {
		const screen = `❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
		expect(isLoggedOut(screen)).toBe(false);
	});

	it("ignores the phrase above the last rule (transcript or composer), not anywhere in the body", () => {
		const screen = `● The DB replied: Not logged in. Run /login there.\n${rule}\n❯ Run /login\n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
		expect(isLoggedOut(screen)).toBe(false);
	});

	it("strips the SGR escapes a real -e capture wraps the footer in", () => {
		const esc = String.fromCharCode(27);
		const ruleAnsi = `${esc}[2m${rule}${esc}[0m`;
		const screen = `❯ \n${ruleAnsi}\n  ⏵⏵ for agents  ${esc}[33mNot logged in${esc}[0m · ${esc}[1mRun /login${esc}[0m`;
		expect(isLoggedOut(screen)).toBe(true);
	});
});

describe("tmuxCore isAtPrompt", () => {
	const rule = "─".repeat(40);

	it("is true whether the composer is idle or mid-turn - the box border renders either way", () => {
		expect(isAtPrompt(`❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`)).toBe(true);
		expect(isAtPrompt(`❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`)).toBe(
			true,
		);
	});

	it("is false with no full-width rule row at all (raw shell, boot screen, menu)", () => {
		expect(isAtPrompt("")).toBe(false);
		expect(isAtPrompt("root@host ~ $ ")).toBe(false);
		expect(isAtPrompt("Loading development channels...")).toBe(false);
		expect(isAtPrompt("  ❯ 1. I am using this for local development\n    2. Exit")).toBe(false);
	});

	it("ignores a partial rule that merely contains dashes rather than being all dashes", () => {
		expect(isAtPrompt("-- 3 dashes inline, not a full rule row --")).toBe(false);
		expect(isAtPrompt(`some text ${rule} trailing text`)).toBe(false);
	});

	it("strips the SGR escapes a real -e capture wraps the rule in", () => {
		const esc = String.fromCharCode(27);
		expect(isAtPrompt(`❯ \n${esc}[2m${rule}${esc}[0m\n  ⏵⏵ for agents`)).toBe(true);
	});
});

describe("tmuxCore awaitReady", () => {
	const target = { kind: "host", name: "host", sessionName: "scratch" } as const;

	it("returns ready+alive once the composer appears, pressing no key", async () => {
		stdoutData = "...restored...\n❯ ";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 200 });
		expect(res).toMatchObject({ alive: true, ready: true });
		expect(calls.some((c) => c.includes("send-keys") && c.includes("1"))).toBe(false);
	});

	it('presses "1" to clear the dev-channels menu while not yet at the REPL', async () => {
		stdoutData = "  ❯ 1. I am using this for local development\n    2. Exit";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
	});

	it('presses "1" on the folder-trust and fullscreen-renderer prompts too', async () => {
		for (const menu of [
			"  Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n    2. No, exit",
			"  Try the new fullscreen renderer?\n  ❯ 1. Yes, try it\n    2. Not now",
		]) {
			calls.length = 0;
			stdoutData = menu;
			await awaitReady(target, { pollMs: 5, timeoutMs: 30 });
			expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
		}
	});

	it('presses "1" when SGR escapes split the prompt phrase in a real -e capture', async () => {
		// capture-pane -e wraps cells in SGR codes, so the phrase is not contiguous in the raw bytes;
		// awaitReady must strip before matching, or the menu never gets cleared.
		const esc = String.fromCharCode(27);
		stdoutData = `  ${esc}[7m❯ 1.${esc}[0m I am ${esc}[1musing${esc}[0m this for ${esc}[2mlocal${esc}[0m development\n    2. Exit`;
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
	});

	it("reports a dead launch (alive:false) early when the pane never captures", async () => {
		exitCode = 1; // capture-pane always fails: the session exited on launch
		// Budget large enough that the dead-launch early-out (not the deadline) is what returns.
		const res = await awaitReady(target, { pollMs: 2, timeoutMs: 5_000 });
		expect(res).toMatchObject({ alive: false, ready: false });
	});
});

describe("tmuxCore selfSessionTarget", () => {
	const saved = process.env.PROJECT_NAME;
	afterEach(() => {
		if (saved === undefined) delete process.env.PROJECT_NAME;
		else process.env.PROJECT_NAME = saved;
	});

	it("derives the session name from the session segment of a composite PROJECT_NAME", () => {
		process.env.PROJECT_NAME = "recipe-app.scratch";
		expect(selfSessionTarget()).toEqual({ kind: "host", name: "host", sessionName: "scratch" });
	});

	it("uses the default session for a bare or unset PROJECT_NAME", () => {
		process.env.PROJECT_NAME = "recipe-app";
		expect(selfSessionTarget().sessionName).toBe(DEFAULT_SESSION);
		delete process.env.PROJECT_NAME;
		expect(selfSessionTarget().sessionName).toBe(DEFAULT_SESSION);
	});
});
