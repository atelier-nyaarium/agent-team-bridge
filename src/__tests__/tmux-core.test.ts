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
		queueMicrotask(() => {
			if (stdoutData) child.stdout.emit("data", Buffer.from(stdoutData));
			child.emit("close", code);
		});
		return child;
	},
}));

import {
	createSession,
	ensureSession,
	hasSession,
	isAgentReady,
	isAgentWorking,
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
});

describe("tmuxCore sendText", () => {
	it("types text + a trailing CR atomically in one send-keys, with -- guarding a leading dash", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "-l hello");
		// One invocation: the CR (the Enter key) rides inside the literal so text and submission
		// cannot be torn apart by a failure between two commands.
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "-l", "--", "-l hello\r"]]);
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
});

describe("tmuxCore peekPane", () => {
	it("captures the visible pane with ANSI and returns a content hash", async () => {
		stdoutData = "screen contents";
		const r = await peekPane({ kind: "host", name: "host", sessionName: "claude" });
		expect(calls[0]).toEqual(["tmux", "capture-pane", "-t", "claude.0", "-e", "-p"]);
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

	it("is false while the first-run wizard is showing, even past the header", () => {
		expect(isAgentReady("Claude Code v2.1.0\nChoose the text style")).toBe(false);
	});

	it("is true at a fresh idle REPL (Claude Code header, no wizard)", () => {
		expect(isAgentReady("Claude Code v2.1.0\n> ")).toBe(true);
	});

	it("is true at a resumed REPL (no header, shows the shortcuts prompt)", () => {
		expect(isAgentReady("...restored conversation...\n? for shortcuts")).toBe(true);
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

	it("treats an already-gone session as success (swallows the error)", async () => {
		exitCode = 1; // kill-session exits non-zero when the session is absent
		await expect(killSession({ kind: "host", name: "host", sessionName: "scratch" })).resolves.toBeUndefined();
	});
});

describe("tmuxCore isAgentWorking", () => {
	it("is true only while the interrupt-spinner footer is showing", () => {
		expect(isAgentWorking("✻ Thinking… (esc to interrupt)")).toBe(true);
		expect(isAgentWorking("")).toBe(false);
		expect(isAgentWorking("Claude Code v2.1.0\n> ")).toBe(false);
		expect(isAgentWorking("...restored conversation...\n? for shortcuts")).toBe(false);
	});
});
