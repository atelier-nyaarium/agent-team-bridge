import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture every spawned argv and simulate a clean (or failing) child, so we can assert
// the exact tmux command shapes without a real tmux/docker.
const calls: string[][] = [];
let exitCode = 0;
let stdoutData = "";

vi.mock("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
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
			child.emit("close", exitCode);
		});
		return child;
	},
}));

import { peekPane, sendKey, sendText } from "../mcp/devcontainer/tmuxCore.js";

afterEach(() => {
	calls.length = 0;
	exitCode = 0;
	stdoutData = "";
});

describe("tmuxCore sendText", () => {
	it("types text + a trailing CR atomically in one send-keys, with -- guarding a leading dash", async () => {
		await sendText({ kind: "gateway", name: "gateway" }, "-l hello");
		// One invocation: the CR (the Enter key) rides inside the literal so text and submission
		// cannot be torn apart by a failure between two commands.
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "-l", "--", "-l hello\r"]]);
	});

	it("targets a devcontainer via docker exec by the compose container name", async () => {
		await sendText({ kind: "devcontainer", name: "recipe-app" }, "hi");
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
		await sendKey({ kind: "gateway", name: "gateway" }, "C-c");
		expect(calls).toEqual([["tmux", "send-keys", "-t", "claude.0", "C-c"]]);
	});

	it("rejects a key not on the whitelist without spawning anything", async () => {
		await expect(sendKey({ kind: "gateway", name: "gateway" }, "rm -rf")).rejects.toThrow(/disallowed key/);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore peekPane", () => {
	it("captures the visible pane with ANSI and returns a content hash", async () => {
		stdoutData = "screen contents";
		const r = await peekPane({ kind: "gateway", name: "gateway" });
		expect(calls[0]).toEqual(["tmux", "capture-pane", "-t", "claude.0", "-e", "-p"]);
		expect(r.ansi).toBe("screen contents");
		expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("rejects a target name that is not a slug before reaching docker", async () => {
		await expect(peekPane({ kind: "devcontainer", name: "x;y" })).rejects.toThrow(/invalid session name/);
		expect(calls).toHaveLength(0);
	});
});
