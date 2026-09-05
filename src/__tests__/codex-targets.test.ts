import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	containerEnvArgs,
	type ExecutionTargetLauncher,
	ExecutionTargetManager,
	realLauncher,
	scrubChildEnv,
} from "../mcp/devcontainer/codexTargets.js";
import { type CodexResolvedTarget, CodexResolvedTargetSchema, parseCodexTargetId } from "../shared/codex-agent.js";

const HOST: CodexResolvedTarget = { kind: "host", targetId: "host", cwd: "/home/dev/projects/app" };
const CONTAINER: CodexResolvedTarget = { kind: "devcontainer", targetId: "container:app", cwd: "/workspace/app" };
type Lifecycle = { kind: "launched" | "exited" | "killed"; targetId: string };

function child(targetId: string, lifecycle: Lifecycle[]) {
	const listeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
	return {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		kill() {
			lifecycle.push({ kind: "killed", targetId });
		},
		onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
			listeners.push(listener);
		},
		exit(code = 1) {
			lifecycle.push({ kind: "exited", targetId });
			for (const listener of listeners) listener({ code, signal: null });
		},
	};
}

function manager(options: { failWith?: Error } = {}) {
	let now = 1_000;
	const lifecycle: Lifecycle[] = [];
	const children: Array<ReturnType<typeof child>> = [];
	const launcher: ExecutionTargetLauncher = {
		launch(target) {
			if (options.failWith) throw options.failWith;
			const next = child(target.targetId, lifecycle);
			children.push(next);
			lifecycle.push({ kind: "launched", targetId: target.targetId });
			return next;
		},
	};
	return {
		manager: new ExecutionTargetManager(
			launcher,
			() => now,
			() => {},
			{ PATH: "/usr/bin", HOST_WS_TOKEN: "secret" },
		),
		children,
		lifecycle,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("child environment", () => {
	it.each([
		[{ HOST_WS_TOKEN: "x", BRIDGE_ROUTER_URL: "y", CONSOLE_BRIDGE_TOKEN: "z" }, "CODEX_", {}],
		[
			{ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8" },
			"CODEX_",
			{ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8" },
		],
		[{ ACME_API_KEY: "x", GH_TOKEN: "y" }, "CODEX_", {}],
		[
			{ CODEX_API_KEY: "k", CODEX_AGENT_MODEL: "gpt-5.6-luna" },
			"CODEX_",
			{ CODEX_API_KEY: "k", CODEX_AGENT_MODEL: "gpt-5.6-luna" },
		],
		[{ COPILOT_API_KEY: "k", CODEX_API_KEY: "c" }, "CODEX_", { CODEX_API_KEY: "c" }],
		[{ COPILOT_API_KEY: "k", CODEX_API_KEY: "c" }, "COPILOT_", { COPILOT_API_KEY: "k" }],
		[{ PATH: "/usr/bin", EMPTY: undefined }, "CODEX_", { PATH: "/usr/bin" }],
	] as const)("scrubs %j for %s", (source, prefix, expected) =>
		expect(scrubChildEnv(source, prefix)).toEqual(expected));

	it("forwards only the agent settings to a container", () => {
		expect(
			containerEnvArgs(
				{ CODEX_AGENT_MODEL: "gpt-5.6-luna", PATH: "/usr/bin", HOST_WS_TOKEN: "secret" },
				"CODEX_",
			),
		).toEqual(["-e", "CODEX_AGENT_MODEL=gpt-5.6-luna"]);
	});
});

describe("target values", () => {
	it.each([
		["host", { kind: "host" }],
		["container:app", { kind: "devcontainer", project: "app" }],
	] as const)("parses %s", (targetId, expected) => expect(parseCodexTargetId(targetId)).toEqual(expected));
	it.each(["app", "container:app; rm -rf /", "container:", "container:UPPER"])("rejects %s at launch", (targetId) => {
		expect(() => realLauncher.launch({ ...CONTAINER, targetId }, {})).toThrow();
	});
	it.each([HOST, CONTAINER])("accepts %j", (target) =>
		expect(CodexResolvedTargetSchema.safeParse(target).success).toBe(true));
	it.each([
		{ ...HOST, targetId: "container:app" },
		{ ...CONTAINER, targetId: "host" },
		{ ...CONTAINER, targetId: "container:Not A Slug" },
	] as const)("rejects contradictory values: %j", (target) =>
		expect(CodexResolvedTargetSchema.safeParse(target).success).toBe(false));
});

describe("execution target lifecycle", () => {
	it("shares a child by target id and isolates target kinds", () => {
		const h = manager();
		const first = h.manager.acquire(HOST);
		const second = h.manager.acquire({ ...HOST, cwd: "/other" });
		h.manager.acquire(CONTAINER);
		expect(first.state).toBe("running");
		expect(second.state === "running" && first.state === "running" && second.lease.child).toBe(
			first.state === "running" && first.lease.child,
		);
		expect(h.lifecycle.filter((event) => event.kind === "launched").map((event) => event.targetId)).toEqual([
			"host",
			"container:app",
		]);
	});

	it("reports collision and relaunches after backoff", () => {
		const h = manager();
		h.manager.acquire(HOST);
		expect(h.manager.acquire({ ...HOST, kind: "devcontainer" }).state).toBe("unavailable");
		h.children[0]?.exit(137);
		expect(h.manager.acquire(HOST)).toEqual({ state: "recovering", retryInMs: 1_000, errorClass: "exit:137" });
		h.advance(1_000);
		expect(h.manager.acquire(HOST).state).toBe("running");
		expect(h.lifecycle.map((event) => event.kind)).toEqual(["launched", "exited", "launched"]);
	});

	it("backs off repeated failures and retries after cooldown", () => {
		const h = manager();
		const waits: number[] = [];
		for (let step = 0; step < 20; step += 1) {
			const result = h.manager.acquire(HOST);
			if (result.state === "unavailable") break;
			if (result.state === "recovering") {
				waits.push(result.retryInMs);
				h.advance(result.retryInMs);
				continue;
			}
			h.children.at(-1)?.exit();
		}
		expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
		expect(h.manager.acquire(HOST).state).toBe("unavailable");
		h.advance(5 * 60_000);
		expect(h.manager.acquire(HOST).state).toBe("running");
	});

	it("uses generations for safe release and exposes child lifecycle", () => {
		const h = manager();
		const first = h.manager.acquire(HOST);
		h.manager.release(HOST.targetId, first.state === "running" ? first.lease.generation : 0);
		h.advance(60_000);
		const second = h.manager.acquire(HOST);
		h.manager.release(HOST.targetId, 1);
		expect(second.state).toBe("running");
		expect(h.lifecycle.map((event) => event.kind)).toEqual(["launched", "killed", "launched"]);
		h.manager.shutdown();
		expect(h.lifecycle.at(-1)?.kind).toBe("killed");
	});

	it("turns launch failures into availability values", () => {
		const h = manager({ failWith: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
		expect(h.manager.acquire(HOST)).toEqual({ state: "recovering", retryInMs: 1_000, errorClass: "ENOENT" });
	});
});
