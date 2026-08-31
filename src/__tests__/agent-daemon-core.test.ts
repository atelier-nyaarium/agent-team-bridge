import { describe, expect, it, vi } from "vitest";
import {
	AgentDaemonCore,
	type AgentDaemonSchema,
	type AgentDaemonSession,
	type AgentEventAck,
} from "../mcp/devcontainer/agentDaemonCore.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import type { AgentResolvedTarget } from "../shared/agent-execution-target.js";

const TARGET = { kind: "host", targetId: "host", cwd: "/workspace" } as AgentResolvedTarget;
const schema: AgentDaemonSchema<Record<string, unknown>> = {
	safeParse(value) {
		return { success: true, data: value as Record<string, unknown> };
	},
};

function session(targetId = "host", generation = 1): AgentDaemonSession {
	return {
		targetId,
		generation,
		nextEventId: 0,
		client: { close: vi.fn() },
	};
}

function core(
	sent: Record<string, unknown>[],
	targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: () => {},
	},
): AgentDaemonCore<AgentDaemonSession> {
	return new AgentDaemonCore({
		backendId: "codex",
		daemonInstanceId: "daemon-1",
		targets,
		send: (message) => sent.push(message),
		isReliable: (message) =>
			typeof message === "object" && message !== null && (message as { reliable?: unknown }).reliable === true,
	});
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

/** Publishing is fenced to the registry, so a session under test has to be one the core opened. */
async function serving(
	daemon: AgentDaemonCore<AgentDaemonSession>,
	targetId = "host",
	generation = 1,
): Promise<AgentDaemonSession> {
	const live = session(targetId, generation);
	await daemon.acquireSession({ ...TARGET, targetId } as AgentResolvedTarget, async () => live);
	return live;
}

describe("AgentDaemonCore", () => {
	it("numbers published messages per session", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = core(sent);
		const live = await serving(daemon);

		daemon.publish(live, { kind: "first" }, schema);
		daemon.publish(live, { kind: "second" }, schema);

		expect(sent.map((message) => message.eventId)).toEqual([0, 1]);
		expect(live.nextEventId).toBe(2);
	});

	it("retains only reliable messages", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = core(sent);
		const live = await serving(daemon);

		daemon.publish(live, { reliable: true }, schema);
		daemon.publish(live, { reliable: false }, schema);
		daemon.publish(live, { reliable: true }, schema);
		sent.length = 0;
		daemon.replay();

		expect(sent.map((message) => message.eventId)).toEqual([0, 2]);
	});

	it("evicts the oldest entry at the per-generation cap and logs it", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = core(sent);
		const live = await serving(daemon);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			for (let index = 0; index <= 1_000; index += 1) {
				daemon.publish(live, { reliable: true }, schema);
			}
			sent.length = 0;
			daemon.replay();

			expect(sent).toHaveLength(1_000);
			expect(sent[0]?.eventId).toBe(1);
			expect(sent.at(-1)?.eventId).toBe(1_000);
			expect(error).toHaveBeenCalledWith("[codex-daemon] outbox overflow, dropped event 0 on host");
		} finally {
			error.mockRestore();
		}
	});

	it("replays entries oldest first and acknowledges committed entries", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = core(sent);
		const first = await serving(daemon, "first");
		const second = await serving(daemon, "second");

		daemon.publish(first, { reliable: true, label: "first-0" }, schema);
		daemon.publish(first, { reliable: true, label: "first-1" }, schema);
		daemon.publish(second, { reliable: true, label: "second-0" }, schema);
		sent.length = 0;
		daemon.replay();

		expect(sent.map((message) => message.label)).toEqual(["first-0", "second-0", "first-1"]);
		daemon.acknowledge({ targetId: "first", generation: 1, throughEventId: 0 } satisfies AgentEventAck);
		sent.length = 0;
		daemon.replay();

		expect(sent.map((message) => message.label)).toEqual(["second-0", "first-1"]);
	});

	it("serializes one agent lane while different agents interleave", async () => {
		const daemon = core([]);
		const order: string[] = [];
		const firstGate = deferred<void>();
		const done = [deferred<void>(), deferred<void>(), deferred<void>()];
		let completed = 0;

		const dispatch = async (command: { agentId: string; step: string }): Promise<void> => {
			order.push(`${command.agentId}:${command.step}:start`);
			if (command.agentId === "agent-a" && command.step === "one") await firstGate.promise;
			order.push(`${command.agentId}:${command.step}:end`);
			done[completed++]?.resolve();
		};
		const reject = vi.fn();

		daemon.enqueue({ ownerKey: "owner", agentId: "agent-a", step: "one" }, dispatch, reject, String);
		daemon.enqueue({ ownerKey: "owner", agentId: "agent-a", step: "two" }, dispatch, reject, String);
		daemon.enqueue({ ownerKey: "owner", agentId: "agent-b", step: "one" }, dispatch, reject, String);
		await settle();

		expect(order).toEqual(["agent-a:one:start", "agent-b:one:start", "agent-b:one:end"]);
		firstGate.resolve();
		await Promise.all(done.map((item) => item.promise));

		expect(order).toEqual([
			"agent-a:one:start",
			"agent-b:one:start",
			"agent-b:one:end",
			"agent-a:one:end",
			"agent-a:two:start",
			"agent-a:two:end",
		]);
		expect(reject).not.toHaveBeenCalled();
	});

	it("shares one concurrent session open", async () => {
		const sent: Record<string, unknown>[] = [];
		const opening = deferred<AgentDaemonSession>();
		const child = {} as AgentChild;
		let opens = 0;
		const targets: TargetSupervisor = {
			acquire: () => ({ state: "running", lease: { generation: 4, child } }),
			release: () => {},
		};
		const daemon = core(sent, targets);
		const build = async (): Promise<AgentDaemonSession> => {
			opens += 1;
			return opening.promise;
		};

		const first = daemon.acquireSession(TARGET, build);
		const second = daemon.acquireSession(TARGET, build);
		await settle();
		expect(opens).toBe(1);

		const live = session("host", 4);
		opening.resolve(live);
		expect(await first).toBe(live);
		expect(await second).toBe(live);
		expect(daemon.hello()).toEqual({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: "host", generation: 4 }],
		});
	});

	it("publishes nothing for a session it has retired, whichever backend built it", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = core(sent);
		const live = await serving(daemon);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			daemon.retire(live);
			daemon.publish(live, { kind: "terminal" }, schema);

			expect(sent).toEqual([]);
			expect(daemon.getSession("host")).toBeUndefined();
		} finally {
			error.mockRestore();
		}
	});

	it("publishes nothing for a session a newer generation replaced", async () => {
		const sent: Record<string, unknown>[] = [];
		let generation = 1;
		const daemon = core(sent, {
			acquire: () => ({ state: "running", lease: { generation, child: {} as AgentChild } }),
			release: () => {},
		});
		const stale = session("host", 1);
		await daemon.acquireSession(TARGET, async () => stale);
		generation = 2;
		await daemon.acquireSession(TARGET, async () => session("host", 2));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			daemon.publish(stale, { kind: "terminal" }, schema);

			expect(sent).toEqual([]);
		} finally {
			error.mockRestore();
		}
	});

	it("advertises no session for a target whose replacement failed to open", async () => {
		const sent: Record<string, unknown>[] = [];
		let generation = 1;
		const daemon = core(sent, {
			acquire: () => ({ state: "running", lease: { generation, child: {} as AgentChild } }),
			release: () => {},
		});
		const first = session("host", 1);
		await daemon.acquireSession(TARGET, async () => first);
		generation = 2;

		await daemon.acquireSession(TARGET, async () => null);

		// Its client is closed, so announcing it would send the gateway reconciling against a dead child.
		expect(first.client.close).toHaveBeenCalled();
		expect(daemon.getSession("host")).toBeUndefined();
		expect(daemon.hello()).toMatchObject({ targets: [] });
	});

	it("hands a slower open for an older generation the session already serving", async () => {
		const sent: Record<string, unknown>[] = [];
		const child = {} as AgentChild;
		let generation = 1;
		const targets: TargetSupervisor = {
			acquire: () => ({ state: "running", lease: { generation, child } }),
			release: () => {},
		};
		const daemon = core(sent, targets);
		const slow = deferred<AgentDaemonSession>();
		const stale = session("host", 1);

		const first = daemon.acquireSession(TARGET, () => slow.promise);
		await settle();
		// The lease turned over while the first open was still in flight.
		generation = 2;
		const live = session("host", 2);
		await daemon.acquireSession(TARGET, async () => live);
		slow.resolve(stale);

		// Reporting the target unavailable would refuse a command its child can serve.
		expect(await first).toBe(live);
		expect(daemon.getSession("host")).toBe(live);
		expect(stale.client.close).toHaveBeenCalled();
		expect(live.client.close).not.toHaveBeenCalled();
	});

	it("lets an open for an older generation not close the one already serving", async () => {
		const sent: Record<string, unknown>[] = [];
		const child = {} as AgentChild;
		const daemon = core(sent, {
			acquire: () => ({ state: "running", lease: { generation: 1, child } }),
			release: () => {},
		});
		const live = session("host", 2);
		await daemon.acquireSession(TARGET, async () => live);

		const built = vi.fn();
		const again = await daemon.acquireSession(TARGET, async () => {
			built();
			return session("host", 1);
		});

		expect(again).toBe(live);
		expect(built).not.toHaveBeenCalled();
		expect(live.client.close).not.toHaveBeenCalled();
	});
});
