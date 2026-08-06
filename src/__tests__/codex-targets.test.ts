import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	type CodexChild,
	containerEnvArgs,
	type ExecutionTargetLauncher,
	ExecutionTargetManager,
	realLauncher,
	scrubChildEnv,
	type TargetLogEvent,
} from "../mcp/devcontainer/codexTargets.js";
import type { CodexResolvedTarget } from "../shared/codex-thinking.js";

////////////////////////////////
//  Functions & Helpers

const HOST: CodexResolvedTarget = { kind: "host", targetId: "host", cwd: "/home/dev/projects/app" };
const CONTAINER: CodexResolvedTarget = { kind: "devcontainer", targetId: "app", cwd: "/workspace/app" };

function fakeChild(): CodexChild & { exit: (code?: number) => void; killed: boolean } {
	const listeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
	const child = {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		killed: false,
		kill() {
			child.killed = true;
		},
		onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
			listeners.push(listener);
		},
		exit(code = 1) {
			for (const l of listeners) l({ code, signal: null });
		},
	};
	return child;
}

/** A manager on a controllable clock, with every launch recorded. */
function harness(options: { failWith?: Error } = {}) {
	const launched: Array<{ target: CodexResolvedTarget; env: Record<string, string> }> = [];
	const children: Array<ReturnType<typeof fakeChild>> = [];
	const logs: TargetLogEvent[] = [];
	let clock = 1_000;

	const launcher: ExecutionTargetLauncher = {
		launch(target, env) {
			launched.push({ target, env });
			if (options.failWith) throw options.failWith;
			const child = fakeChild();
			children.push(child);
			return child;
		},
	};

	const manager = new ExecutionTargetManager(
		launcher,
		() => clock,
		(e) => logs.push(e),
		{ PATH: "/usr/bin", HOST_WS_TOKEN: "secret" },
	);

	return {
		manager,
		launched,
		children,
		logs,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

////////////////////////////////
//  Tests

describe("what a Codex child inherits", () => {
	it("drops Switchboard's own secrets", () => {
		const env = scrubChildEnv({ HOST_WS_TOKEN: "x", BRIDGE_ROUTER_URL: "y", CONSOLE_BRIDGE_TOKEN: "z" });

		expect(Object.keys(env)).toEqual([]);
	});

	it("keeps what the toolchain needs", () => {
		const env = scrubChildEnv({ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8" });

		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8" });
	});

	it("drops an unfamiliar secret-shaped variable", () => {
		expect(scrubChildEnv({ ACME_API_KEY: "x", GH_TOKEN: "y" })).toEqual({});
	});

	it("keeps a Codex variable that is itself secret-shaped", () => {
		// The carve-out only shows up on a name that would otherwise match, so the case has to use one.
		expect(scrubChildEnv({ CODEX_API_KEY: "k", CODEX_THINKING_MODEL: "gpt-5.6-luna" })).toEqual({
			CODEX_API_KEY: "k",
			CODEX_THINKING_MODEL: "gpt-5.6-luna",
		});
	});

	it("drops every name on the deny list, not just the obviously secret ones", () => {
		const denied = {
			HOST_WS_TOKEN: "a",
			BRIDGE_ROUTER_URL: "b",
			CONSOLE_BRIDGE_TOKEN: "c",
			FEDERATION_DOMAIN_ID: "d",
			GATEWAY_ID: "e",
			MCP_CONNECTOR_PORT: "f",
			PROJECT_NAME: "g",
			PROJECT_HOST_PATH: "h",
			AGENT_TYPE: "i",
		};

		expect(scrubChildEnv(denied)).toEqual({});
	});

	it("carries no undefined values through to the child", () => {
		expect(scrubChildEnv({ PATH: "/usr/bin", EMPTY: undefined })).toEqual({ PATH: "/usr/bin" });
	});
});

describe("one App Server per execution target", () => {
	it("starts a target's child on first use and reuses it after", () => {
		const h = harness();

		const first = h.manager.acquire(HOST);
		const second = h.manager.acquire(HOST);

		expect(h.launched).toHaveLength(1);
		expect(first.state).toBe("running");
		expect(second.state === "running" && second.lease.child).toBe(first.state === "running" && first.lease.child);
	});

	it("keeps separate targets on separate children", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.manager.acquire(CONTAINER);

		expect(h.launched.map((l) => l.target.targetId)).toEqual(["host", "app"]);
	});

	it("launches with a scrubbed environment", () => {
		const h = harness();
		h.manager.acquire(HOST);

		expect(h.launched[0]?.env).toEqual({ PATH: "/usr/bin" });
	});
});

describe("a child that dies", () => {
	it("takes only its own target down", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.manager.acquire(CONTAINER);
		h.children[0]?.exit();

		expect(h.manager.acquire(CONTAINER).state).toBe("running");
	});

	it("holds the target off until its backoff elapses, then relaunches", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.children[0]?.exit();

		expect(h.manager.acquire(HOST).state).toBe("recovering");

		h.advance(1_000);

		expect(h.manager.acquire(HOST).state).toBe("running");
		expect(h.launched).toHaveLength(2);
	});

	it("waits longer after each successive failure, up to a ceiling", () => {
		const h = harness();
		const waits: number[] = [];
		for (let i = 0; i < 8; i++) {
			const result = h.manager.acquire(HOST);
			if (result.state === "recovering") {
				waits.push(result.retryInMs);
				h.advance(result.retryInMs);
				continue;
			}
			h.children[h.children.length - 1]?.exit();
		}

		expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
		expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
	});

	it("gives up after repeated fast failures rather than looping forever", () => {
		const h = harness();
		for (let i = 0; i < 5; i++) {
			h.manager.acquire(HOST);
			h.children[i]?.exit();
			h.advance(60_000);
		}

		expect(h.manager.acquire(HOST).state).toBe("unavailable");
	});

	it("tries a given-up target once more after a cooldown, so a repaired one needs no restart", () => {
		const h = harness();
		for (let i = 0; i < 5; i++) {
			h.manager.acquire(HOST);
			h.children[i]?.exit();
			h.advance(60_000);
		}
		expect(h.manager.acquire(HOST).state).toBe("unavailable");

		h.advance(5 * 60_000);

		expect(h.manager.acquire(HOST).state).toBe("running");
	});

	it("reports what the exit actually was rather than one generic class", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.children[0]?.exit(137);

		const result = h.manager.acquire(HOST);

		expect(result.state === "recovering" && result.errorClass).toBe("exit:137");
	});

	it("does not count a crash after real work toward giving up", () => {
		const h = harness();
		for (let i = 0; i < 8; i++) {
			h.manager.acquire(HOST);
			h.advance(30_000);
			h.children[i]?.exit();
			h.advance(60_000);
		}

		expect(h.manager.acquire(HOST).state).toBe("running");
	});

	it("does not let a replaced child's late exit retire its successor", () => {
		const h = harness();
		h.manager.acquire(HOST);
		const first = h.children[0];
		h.manager.release(HOST.targetId);
		h.advance(60_000);
		h.manager.acquire(HOST);

		first?.exit();

		expect(h.manager.acquire(HOST).state).toBe("running");
	});
});

describe("a target that cannot launch at all", () => {
	it("reports why instead of throwing at the caller", () => {
		const h = harness({ failWith: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) });

		const result = h.manager.acquire(HOST);

		expect(result.state).toBe("recovering");
		expect(result.state === "recovering" && result.errorClass).toBe("ENOENT");
	});

	it("logs the class without the message, which could carry a path or child output", () => {
		const h = harness({
			failWith: Object.assign(new Error("/home/dev/secret/path not found"), { code: "ENOENT" }),
		});
		h.manager.acquire(HOST);

		expect(JSON.stringify(h.logs)).not.toContain("secret");
		expect(h.logs.some((e) => e.errorClass === "ENOENT")).toBe(true);
	});
});

describe("what reaches a container", () => {
	it("forwards only Codex's own settings, since the container has its own environment", () => {
		expect(containerEnvArgs({ CODEX_THINKING_MODEL: "gpt-5.6-luna", PATH: "/usr/bin", HOME: "/root" })).toEqual([
			"-e",
			"CODEX_THINKING_MODEL=gpt-5.6-luna",
		]);
	});

	it("forwards nothing of Switchboard's, even under a Codex-shaped name", () => {
		expect(containerEnvArgs({ HOST_WS_TOKEN: "secret", GH_TOKEN: "t" })).toEqual([]);
	});

	it("refuses a target name that is not a slug, before it can reach docker exec", () => {
		const evil: CodexResolvedTarget = { kind: "devcontainer", targetId: "app; rm -rf /", cwd: "/workspace/app" };

		expect(() => realLauncher.launch(evil, {})).toThrow();
	});
});

describe("reaping", () => {
	it("kills a target's child on release", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.manager.release(HOST.targetId);

		expect(h.children[0]?.killed).toBe(true);
	});

	it("kills every child on shutdown, so none outlives the daemon", () => {
		const h = harness();
		h.manager.acquire(HOST);
		h.manager.acquire(CONTAINER);
		h.manager.shutdown();

		expect(h.children.map((c) => c.killed)).toEqual([true, true]);
	});

	it("starts a fresh generation after a release", () => {
		const h = harness();
		const before = h.manager.acquire(HOST);
		h.manager.release(HOST.targetId);
		const after = h.manager.acquire(HOST);

		expect(after.state === "running" && after.lease.generation).toBe(
			(before.state === "running" ? before.lease.generation : 0) + 1,
		);
	});
});
