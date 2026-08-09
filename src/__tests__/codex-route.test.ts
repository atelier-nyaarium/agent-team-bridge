import { describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { CodexRoute } from "../gateway/codexRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import { CodexAgentResultSchema, codexAgentIdForOperation } from "../shared/codex-thinking.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function setup(options: { project?: string } = {}) {
	let catalogWriter: CodexCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		codexCatalogPersistence: {
			persistChecked: () => {},
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({
		auth,
		sessionStore,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	const sent: Record<string, unknown>[] = [];
	const relay = new CodexRelay({
		service,
		sessionStore,
		sendToHost: (message) => {
			sent.push(message);
			return true;
		},
	});
	const owner = sessionStore.mint({ spawn: options.project ?? "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	// Short budget so a non-waiting assertion does not sit on the real nine minutes.
	const route = new CodexRoute({ service, relay, waitBudgetMs: 20 });
	return { route, relay, sent, token, owner, sessionStore, service };
}

function post(token: string): Request {
	return new Request("http://gateway/codex", { method: "POST", headers: { "x-session-token": token } });
}

describe("Codex gateway route", () => {
	it("answers a start with a valid envelope naming the derived agent", async () => {
		const context = setup();
		const response = await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit the parser",
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		// Parsed, not merely shaped: an envelope the schema rejects is what made every failing call
		// answer HTML the first time this shipped.
		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.agentId).toBe(codexAgentIdForOperation(OPERATION_ID));
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([{ kind: "start" }]);
	});

	it("returns the same agent when the same operation is retried", async () => {
		const context = setup();
		const body = { kind: "start", operationId: OPERATION_ID, prompt: "Audit" };
		const first = await (await context.route.handle(post(context.token), body)).json();
		const second = await (await context.route.handle(post(context.token), body)).json();

		expect(second.agentId).toBe(first.agentId);
		// One dispatch, not two: the retry replayed rather than delegating the task a second time.
		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(1);
	});

	it("reports an unreachable execution target as a valid unavailable envelope", async () => {
		const context = setup({ project: "unknown-project" });
		const response = await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
		});
		const body = await response.json();

		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.observation).toBe("unavailable");
		expect(body.error).toMatchObject({ code: "daemon_unavailable", retryable: true });
	});

	it("refuses a message for an agent this session does not own", async () => {
		const context = setup();
		const response = await context.route.handle(post(context.token), {
			kind: "message",
			operationId: OPERATION_ID,
			agentId: "codex_ffffffffffffffffffffffffffffffff",
			prompt: "Continue",
		});
		const body = await response.json();

		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.error?.code).toBe("not_found");
	});

	it("answers an unknown session identically to an unknown agent", async () => {
		const context = setup();
		const response = await context.route.handle(new Request("http://gateway/codex", { method: "POST" }), {
			kind: "list",
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not found" });
	});

	it("lists only this session's agents", async () => {
		const context = setup();
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
		});
		const body = await (await context.route.handle(post(context.token), { kind: "list" })).json();

		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].exchanges[0]).toMatchObject({ kind: "start", prompt: "Audit" });
	});

	/** Drive an agent to accepted-and-working, the state every stop and await has to survive. */
	async function working(context: ReturnType<typeof setup>) {
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
		});
		const agentId = codexAgentIdForOperation(OPERATION_ID);
		const command = context.sent.find((message) => message.type === "codex_command") as Record<string, unknown>;
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 0,
			agentId,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		});
		for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
		return agentId;
	}

	it("does not reconcile the very turn a caller is waiting on", async () => {
		const context = setup();
		const agentId = await working(context);
		context.sent.length = 0;

		await context.route.handle(post(context.token), { kind: "await", agentId });

		// Asking the daemon about a live turn makes it answer `recovering` whenever it cannot confirm
		// that exact turn, which settles this wait at once and reports running work as unconfirmed.
		expect(context.sent.filter((message) => message.type === "codex_command")).toEqual([]);
	});

	it("reports the daemon's own reason for a refusal, not a wait-budget timeout", async () => {
		const context = setup();
		const OPERATION = "123e4567-e89b-42d3-a456-42661417400c";
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION,
			prompt: "Audit",
			model: "gpt-5-typo",
		});
		await Promise.resolve();
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "rejected",
			requestId: "123e4567-e89b-42d3-a456-4266141740aa",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			eventId: 1,
			agentId: codexAgentIdForOperation(OPERATION),
			operationId: OPERATION,
			error: "model not offered: gpt-5-typo",
		});
		const body = await (await start).json();

		// The whole safety story for the model input is that an unoffered one is refused rather than
		// swapped. That is worth nothing if the caller cannot learn which part was wrong.
		expect(body.error?.message).toBe("model not offered: gpt-5-typo");
	});

	it("carries a caller's model choice through to the daemon", async () => {
		const context = setup();
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
			model: "gpt-5.6-luna",
		});

		// The override path exists in the App Server client; without this it was unreachable.
		expect(context.sent.find((message) => message.type === "codex_command")).toMatchObject({
			kind: "start",
			model: "gpt-5.6-luna",
		});
	});

	it("reports a turn still running at the budget as a timeout, with its delivery", async () => {
		const context = setup();
		await working(context);

		const body = await (
			await context.route.handle(post(context.token), {
				kind: "start",
				operationId: OPERATION_ID,
				prompt: "Audit",
			})
		).json();

		expect(body.observation).toBe("waitTimedOut");
		expect(body.delivery).toBe("started");
	});

	it("answers a stop on a working agent instead of crashing on its own envelope", async () => {
		const context = setup();
		const agentId = await working(context);

		const response = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174009",
			agentId,
		});
		const body = await response.json();

		// The whole point of stop is to halt runaway work, so this must not be the one call that 500s.
		expect(response.status).toBe(200);
		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.observation).toBe("interruptRequested");
		expect(body.delivery).toBeUndefined();
	});

	it("answers an await on an agent still being created", async () => {
		const context = setup();
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
		});

		// Exactly what the await tool's own description tells a caller to do after a start times out.
		const response = await context.route.handle(post(context.token), {
			kind: "await",
			agentId: codexAgentIdForOperation(OPERATION_ID),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body).toMatchObject({ agentState: "creating", observation: "waitTimedOut" });
	});

	it("answers a state conflict as a refused request, not as a broken agent", async () => {
		const context = setup();
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "Audit",
		});

		// Messaging an agent that is still creating is an ordinary conflict, not an outage.
		const response = await context.route.handle(post(context.token), {
			kind: "message",
			operationId: "123e4567-e89b-42d3-a456-426614174009",
			agentId: codexAgentIdForOperation(OPERATION_ID),
			prompt: "Continue",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_input", retryable: false } });
	});

	it("settles an unproven delivery into recovery rather than an unparseable result", async () => {
		const context = setup();
		const agentId = await working(context);
		// Settle the first turn so the agent is idle and can take a message.
		context.relay.handleHostMessage({
			type: "codex_event",
			kind: "terminal",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 1,
			agentId,
			threadId: "thread-1",
			turnId: "turn-1",
			state: "completed",
			finalResponse: "done",
		});
		for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();

		// A message whose acceptance never arrives, waited out to the (tiny) budget.
		const response = await context.route.handle(post(context.token), {
			kind: "message",
			operationId: "123e4567-e89b-42d3-a456-42661417400a",
			agentId,
			prompt: "Continue",
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.observation).toBe("indeterminate");
		// The record moved with the report: a later prompt is refused until reconciliation runs.
		expect(context.service.listOwnedAgents(context.owner)[0]?.agentState).toBe("recovering");
	});

	it("never reports a previous turn's answer for an agent whose state is unconfirmed", async () => {
		const context = setup();
		const agentId = await working(context);
		context.relay.handleHostMessage({
			type: "codex_event",
			kind: "terminal",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 1,
			agentId,
			threadId: "thread-1",
			turnId: "turn-1",
			state: "completed",
			finalResponse: "ANSWER TO THE FIRST PROMPT",
		});
		for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();

		// A second prompt whose delivery is never proven puts the record into recovery.
		await context.route.handle(post(context.token), {
			kind: "message",
			operationId: "123e4567-e89b-42d3-a456-42661417400b",
			agentId,
			prompt: "A DIFFERENT QUESTION",
		});
		expect(context.service.listOwnedAgents(context.owner)[0]?.agentState).toBe("recovering");

		const body = await (await context.route.handle(post(context.token), { kind: "await", agentId })).json();

		// Handing back the first prompt's answer here would tell the caller their second prompt
		// succeeded, quoting a reply to a question it never asked.
		expect(body.finalResponse).toBeUndefined();
		expect(body.observation).toBe("unavailable");
		expect(body.agentState).toBe("recovering");
	});

	it("asks the daemon about a stale record when a caller lists or awaits", async () => {
		const context = setup();
		await working(context);
		context.sent.length = 0;

		await context.route.handle(post(context.token), { kind: "list" });

		// A daemon that never disconnects would otherwise never be asked, leaving the record stale for
		// the rest of the session.
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile" },
		]);
	});

	it("rejects a malformed request before allocating anything", async () => {
		const context = setup();
		const response = await context.route.handle(post(context.token), {
			kind: "start",
			operationId: OPERATION_ID,
			prompt: "   ",
		});

		expect(response.status).toBe(400);
		expect(context.sent).toEqual([]);
	});
});
