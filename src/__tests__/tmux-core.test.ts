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
		const out = args.includes("capture-pane") ? stdoutData : "";
		queueMicrotask(() => {
			if (out) child.stdout.emit("data", Buffer.from(out));
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
	isLoggedOut,
	killSession,
	peekPane,
	sendKey,
	sendText,
} from "../mcp/devcontainer/tmuxCore.js";

afterEach(() => {
	calls.length = 0;
	exitCode = 0;
	exitQueue.length = 0;
	stdoutData = "";
	stderrData = "";
});

describe("tmuxCore sendText", () => {
	it("types text + a trailing CR atomically in one send-keys, with -- guarding a leading dash", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "-l hello");
		// One invocation: the CR (the Enter key) rides inside the literal so text and submission
		// cannot be torn apart by a failure between two commands.
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "-l", "--", "-l hello\r"]]);
	});

	it("omits the trailing CR when submit is false (types into the composer without submitting)", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "hello", false);
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "-l", "--", "hello"]]);
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
			"claude.0",
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
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "C-c"]]);
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
		expect(calls[0]).toEqual(["tmux", "resize-window", "-t", "claude", "-x", "58", "-y", "40"]);
		expect(calls[1]).toEqual(["tmux", "capture-pane", "-t", "claude.0", "-e", "-p"]);
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
			"scratch",
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
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "scratch"]);
	});

	it("ensureSession launches a fresh session when absent", async () => {
		exitQueue.push(1, 0); // has-session absent, then new-session succeeds
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: true });
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "scratch"]);
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
		expect(calls).toEqual([["tmux", "kill-session", "-t", "scratch"]]);
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
			"scratch",
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
	it("is working when the last spinner line shows the ellipsis or Waiting for", () => {
		expect(isAgentWorking("✻ Prestidigitating…")).toBe(true);
		expect(isAgentWorking("✻ Waiting for 1 dynamic workflow to finish")).toBe(true);
	});

	it("is not working at an idle composer, an empty pane, or a settled spinner", () => {
		expect(isAgentWorking("")).toBe(false);
		expect(isAgentWorking("❯ ")).toBe(false);
		expect(isAgentWorking("✻ Brewed for 7s")).toBe(false);
		expect(isAgentWorking("✻ Brewed for 19s · 1 monitor still running")).toBe(false);
	});

	it("keys off the LAST spinner line, ignoring a stale done marker in scrollback", () => {
		expect(isAgentWorking("✻ Brewed for 1h 25m\n✻ Prestidigitating…")).toBe(true);
		// A prose ellipsis above the live settled line is ignored: only the ✻ line is read.
		expect(isAgentWorking("● done thinking…\n✻ Brewed for 7s")).toBe(false);
	});

	it("strips the SGR escapes around a real -e spinner line", () => {
		const esc = String.fromCharCode(27);
		expect(isAgentWorking(`${esc}[38;5;1m✻${esc}[0m Prestidigitating${esc}[2m…${esc}[0m`)).toBe(true);
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
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "scratch.0", "-l", "--", "1"]);
	});

	it('presses "1" on the folder-trust and fullscreen-renderer prompts too', async () => {
		for (const menu of [
			"  Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n    2. No, exit",
			"  Try the new fullscreen renderer?\n  ❯ 1. Yes, try it\n    2. Not now",
		]) {
			calls.length = 0;
			stdoutData = menu;
			await awaitReady(target, { pollMs: 5, timeoutMs: 30 });
			expect(calls).toContainEqual(["tmux", "send-keys", "-t", "scratch.0", "-l", "--", "1"]);
		}
	});

	it('presses "1" when SGR escapes split the prompt phrase in a real -e capture', async () => {
		// capture-pane -e wraps cells in SGR codes, so the phrase is not contiguous in the raw bytes;
		// awaitReady must strip before matching, or the menu never gets cleared.
		const esc = String.fromCharCode(27);
		stdoutData = `  ${esc}[7m❯ 1.${esc}[0m I am ${esc}[1musing${esc}[0m this for ${esc}[2mlocal${esc}[0m development\n    2. Exit`;
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "scratch.0", "-l", "--", "1"]);
	});

	it("reports a dead launch (alive:false) early when the pane never captures", async () => {
		exitCode = 1; // capture-pane always fails: the session exited on launch
		// Budget large enough that the dead-launch early-out (not the deadline) is what returns.
		const res = await awaitReady(target, { pollMs: 2, timeoutMs: 5_000 });
		expect(res).toMatchObject({ alive: false, ready: false });
	});
});
