import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodexDaemonEvent, CodexDaemonReceipt } from "../shared/codexAgentRelay.js";
import { composeSessionName } from "../shared/session-id.js";
import { type CodexResponder, stockCodexResponder } from "../testing/fakeHost.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

interface AgentAnswer {
	agentId: string;
	agentState: string;
	observation: string;
	turn?: { id: string; state: string };
	finalResponse?: string;
	activities: Array<{ text?: string }>;
	error?: { code: string };
}

describe("Codex delegation through the gateway and the daemon", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	const operationId = () => randomUUID();
	/** The only caller the route admits. */
	const launch = async (label: string): Promise<FakeSession> => {
		h.host.handlers.onCreateSession = (op) => {
			sessions.push(
				attachFakeSession(h.gateway, {
					team: composeSessionName(op.target.name, op.target.sessionName),
					conversationId: `conv-${label.toLowerCase()}`,
					sessionToken: op.sessionToken,
				}),
			);
		};
		const before = sessions.length;
		const { result } = await h.phone.value({ kind: "create_session", target: "host", displayLabel: label });
		expect(result).toMatchObject({ created: true });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		return created;
	};
	const codex = async (caller: FakeSession, body: Record<string, unknown>): Promise<AgentAnswer> => {
		const response = await caller.post("/codex", body);
		return (await response.json()) as AgentAnswer;
	};
	let alice: FakeSession;
	let carol: FakeSession;

	beforeAll(async () => {
		h = await startFederationHarness();
		alice = await launch("Alice");
		carol = await launch("Carol");
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("starts an agent on the host, and the daemon's completed turn comes back as the answer", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "count to three" });
		expect(started).toMatchObject({
			agentState: "idle",
			observation: "terminal",
			turn: { state: "completed" },
			finalResponse: "done: count to three",
		});
		expect(started.activities.map((activity) => activity.text)).toContain("working");
		const command = h.host.codexCommands.find((candidate) => candidate.kind === "start");
		expect(command).toMatchObject({ target: { kind: "host" }, prompt: "count to three", agentId: started.agentId });
	});

	it("continues the same thread on a message, and replays a duplicated operation without a second turn", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "first" });
		const followUp = operationId();
		const answered = await codex(alice, {
			kind: "message",
			operationId: followUp,
			agentId: started.agentId,
			prompt: "second",
		});
		expect(answered).toMatchObject({ turn: { state: "completed" }, finalResponse: "done: second" });
		const thread = h.host.codexCommands.find((c) => c.kind === "message" && c.agentId === started.agentId);
		expect(thread).toMatchObject({ threadId: `thread-${started.agentId}` });

		const again = await codex(alice, {
			kind: "message",
			operationId: followUp,
			agentId: started.agentId,
			prompt: "second",
		});
		expect(again.turn?.id).toBe(answered.turn?.id);
		expect(h.host.codexCommands.filter((c) => c.kind === "message" && c.operationId === followUp)).toHaveLength(1);
	});

	it("lists an owner's agents to that owner alone", async () => {
		const mine = await codex(alice, { kind: "start", operationId: operationId(), prompt: "mine" });
		const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
			agents: Array<{ agentId: string }>;
		};
		expect(listed.agents.map((agent) => agent.agentId)).toContain(mine.agentId);
		const theirs = (await (await carol.post("/codex", { kind: "list" })).json()) as {
			agents: Array<{ agentId: string }>;
		};
		expect(theirs.agents.map((agent) => agent.agentId)).not.toContain(mine.agentId);
		const peek = await codex(carol, { kind: "await", agentId: mine.agentId });
		expect(peek).toMatchObject({ agentState: "unavailable", error: { code: "not_found" } });
	});

	it("refuses a caller with no session binding", async () => {
		const loose = attachFakeSession(h.gateway, { team: "fixture-app.loose", conversationId: "conv-loose" });
		sessions.push(loose);
		await loose.ready();
		const response = await loose.post("/codex", { kind: "start", operationId: operationId(), prompt: "no" });
		expect(response.status).toBe(401);
	});

	it("interrupts a running turn: the daemon's interrupt result settles the start as interrupted", async () => {
		const running: CodexResponder = (command, daemon) => {
			if (command.kind === "start") return stockCodexResponder(command, daemon)?.slice(0, 2);
			if (command.kind === "interrupt") {
				const base = {
					ownerKey: command.ownerKey,
					daemonInstanceId: daemon.daemonInstanceId,
					agentId: command.agentId,
				};
				const fence = { targetId: command.target.targetId, generation: daemon.generation };
				return [
					{
						type: "codex_receipt",
						requestId: command.requestId,
						...base,
						...fence,
						eventId: daemon.nextEventId(fence.targetId),
						kind: "interruptResult",
						operationId: command.operationId,
						threadId: command.threadId,
						turnId: command.turnId,
						ok: true,
					},
					{
						type: "codex_event",
						...base,
						...fence,
						eventId: daemon.nextEventId(fence.targetId),
						threadId: command.threadId,
						kind: "terminal",
						turnId: command.turnId,
						state: "interrupted",
					},
				];
			}
			return stockCodexResponder(command, daemon);
		};
		h.host.handlers.onCodexCommand = running;
		try {
			const startId = operationId();
			const starting = codex(alice, { kind: "start", operationId: startId, prompt: "long task" });
			const working = await h.waitFor(async () => {
				const listed = (await (await alice.post("/codex", { kind: "list", detail: "full" })).json()) as {
					agents: Array<{ agentId: string; agentState: string; turns?: Array<{ state: string }> }>;
				};
				return listed.agents.find(
					(agent) =>
						agent.agentState === "working" && agent.turns?.some((turn) => turn.state === "inProgress"),
				);
			}, "an accepted turn in progress");
			const stopped = await codex(alice, { kind: "stop", operationId: operationId(), agentId: working.agentId });
			expect(stopped.agentId, JSON.stringify(stopped)).toBe(working.agentId);
			expect(await starting).toMatchObject({ agentState: "idle", turn: { state: "interrupted" } });
			expect(h.host.codexCommands.find((c) => c.kind === "interrupt")).toMatchObject({
				agentId: working.agentId,
			});
		} finally {
			h.host.handlers.onCodexCommand = undefined;
		}
	});

	it("keeps one turn when the daemon replays its reliable frames", async () => {
		const replayed: Array<CodexDaemonEvent | CodexDaemonReceipt> = [];
		h.host.handlers.onCodexCommand = (command, daemon) => {
			const frames = stockCodexResponder(command, daemon) ?? [];
			if (command.kind === "start") replayed.push(...(frames as Array<CodexDaemonEvent | CodexDaemonReceipt>));
			return frames;
		};
		try {
			const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "replay me" });
			for (const frame of replayed) h.host.sendCodex(frame);
			const listed = (await (await alice.post("/codex", { kind: "list", detail: "full" })).json()) as {
				agents: Array<{ agentId: string; turns?: unknown[] }>;
			};
			const agent = listed.agents.find((candidate) => candidate.agentId === started.agentId);
			expect(agent?.turns ?? []).toHaveLength(1);
			expect(await codex(alice, { kind: "await", agentId: started.agentId })).toMatchObject({
				turn: { id: started.turn?.id, state: "completed" },
			});
		} finally {
			h.host.handlers.onCodexCommand = undefined;
		}
	});

	it("survives a gateway restart: the agent is still listed and answers a new message", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "before restart" });
		await h.restartGateway();
		const reattached = attachFakeSession(h.gateway, {
			team: alice.team,
			conversationId: alice.conversationId,
			sessionToken: alice.sessionToken,
		});
		sessions.push(reattached);
		expect(await reattached.registered()).toMatchObject({ type: "register_ok" });
		await reattached.ready();
		const listed = await h.waitFor(async () => {
			const answer = (await (await reattached.post("/codex", { kind: "list" })).json()) as {
				agents?: Array<{ agentId: string }>;
			};
			return answer.agents?.some((agent) => agent.agentId === started.agentId) ? answer : undefined;
		}, "the agent after restart");
		expect(listed.agents?.map((agent) => agent.agentId)).toContain(started.agentId);
		const answered = await codex(reattached, {
			kind: "message",
			operationId: operationId(),
			agentId: started.agentId,
			prompt: "after restart",
		});
		expect(answered).toMatchObject({ turn: { state: "completed" }, finalResponse: "done: after restart" });
	});

	it("after a daemon restart, the first message is retryable and the retry lands once the agent is re-fenced", async () => {
		const caller = sessions.at(-1) as FakeSession;
		const started = await codex(caller, {
			kind: "start",
			operationId: operationId(),
			prompt: "before daemon restart",
		});
		h.restartHost({ newDaemon: true });
		const first = await codex(caller, {
			kind: "message",
			operationId: operationId(),
			agentId: started.agentId,
			prompt: "who are you now?",
		});
		expect(first).toMatchObject({
			observation: "indeterminate",
			error: { code: "indeterminate", retryable: true },
		});
		const recovered = await h.waitFor(async () => {
			const listed = (await (await caller.post("/codex", { kind: "list" })).json()) as {
				agents: Array<{ agentId: string; agentState: string }>;
			};
			return listed.agents.find((agent) => agent.agentId === started.agentId && agent.agentState === "idle");
		}, "the agent back to idle");
		expect(recovered.agentId).toBe(started.agentId);
		const retried = await codex(caller, {
			kind: "message",
			operationId: operationId(),
			agentId: started.agentId,
			prompt: "who are you now?",
		});
		expect(retried).toMatchObject({ turn: { state: "completed" }, finalResponse: "done: who are you now?" });
	});
});
