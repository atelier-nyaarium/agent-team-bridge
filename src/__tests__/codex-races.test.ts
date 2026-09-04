import { describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { CodexRoute } from "../gateway/codexRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import { CodexAgentResultSchema, codexAgentIdForOperation } from "../shared/codex-agent.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const START = "123e4567-e89b-42d3-a456-426614174000";
const TARGET_ID = "container:recipe-app";
const RESOLVED = { kind: "devcontainer" as const, targetId: TARGET_ID, cwd: "/workspace/recipe-app" };

function setup() {
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
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	return {
		service,
		relay,
		sent,
		owner,
		token,
		ownerKey: sessionStore.teamOf(owner),
		route: new CodexRoute({ service, relay, waitBudgetMs: 20 }),
		agentOf: () => sessionStore.listCodexAgents(owner)[0],
		/** A second, unrelated session on the same gateway, for the isolation checks. */
		otherSession(): string {
			const other = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Other" });
			const otherToken = sessionStore.ensureBindToken(other);
			sessionStore.activateBinding(other);
			sessionStore.confirm(sessionStore.teamOf(other));
			return otherToken;
		},
	};
}

function post(token: string): Request {
	return new Request("http://gateway/codex", { method: "POST", headers: { "x-session-token": token } });
}

async function settle() {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

function receipt(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
	return {
		type: "codex_receipt",
		requestId: "123e4567-e89b-42d3-a456-4266141740aa",
		ownerKey: context.ownerKey,
		daemonInstanceId: "daemon-1",
		targetId: TARGET_ID,
		generation: 1,
		eventId,
		agentId: codexAgentIdForOperation(START),
		...extra,
	};
}

function event(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
	return {
		type: "codex_event",
		ownerKey: context.ownerKey,
		daemonInstanceId: "daemon-1",
		targetId: TARGET_ID,
		generation: 1,
		eventId,
		agentId: codexAgentIdForOperation(START),
		threadId: "thread-1",
		...extra,
	};
}

/** An agent accepted on turn-1 and working, which is where most of these races begin. */
async function working(context: ReturnType<typeof setup>) {
	await context.route.handle(post(context.token), {
		kind: "start",
		operationId: START,
		prompt: "Audit",
	});
	context.relay.handleHostMessage(
		receipt(context, 0, {
			kind: "accepted",
			operationId: START,
			resolvedTarget: RESOLVED,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		}),
	);
	await settle();
	return codexAgentIdForOperation(START);
}

describe("Codex event ordering", () => {
	it("ignores a redelivered terminal instead of settling the turn twice", async () => {
		const context = setup();
		const agentId = await working(context);
		const terminal = event(context, 1, {
			kind: "terminal",
			turnId: "turn-1",
			state: "completed",
			finalResponse: "first",
		});

		context.relay.handleHostMessage(terminal);
		await settle();
		context.relay.handleHostMessage(terminal);
		await settle();

		const agent = context.agentOf();
		expect(agent?.turns).toHaveLength(1);
		expect(agent?.turns[0]).toMatchObject({ state: "completed", finalResponse: "first" });
		expect(agent?.agentId).toBe(agentId);
	});

	it("refuses a stale event that arrives after a later one", async () => {
		const context = setup();
		await working(context);
		context.relay.handleHostMessage(
			event(context, 5, { kind: "activity", turnId: "turn-1", itemId: "later", text: "later" }),
		);
		await settle();
		context.relay.handleHostMessage(
			event(context, 2, { kind: "activity", turnId: "turn-1", itemId: "earlier", text: "earlier" }),
		);
		await settle();

		// Only the one that advanced the fence is kept; replaying an older id cannot rewrite history.
		expect(context.agentOf()?.turns[0]?.activities).toMatchObject([{ itemId: "later" }]);
	});

	it("keeps a turn's outcome when a terminal for a different thread arrives", async () => {
		const context = setup();
		await working(context);
		context.relay.handleHostMessage(
			event(context, 1, {
				threadId: "thread-other",
				kind: "terminal",
				turnId: "turn-1",
				state: "completed",
				finalResponse: "not mine",
			}),
		);
		await settle();

		expect(context.agentOf()?.turns[0]?.state).toBe("inProgress");
	});
});

describe("Codex stop semantics", () => {
	it("does not redispatch an interrupt while one is already pending", async () => {
		const context = setup();
		const agentId = await working(context);
		await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174001",
			agentId,
		});
		const dispatched = context.sent.filter((m) => m.kind === "interrupt").length;

		const second = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174002",
			agentId,
		});

		expect(second.status).toBe(400);
		expect(context.sent.filter((m) => m.kind === "interrupt")).toHaveLength(dispatched);
	});

	it("settles a stop as completed when completion won the race", async () => {
		const context = setup();
		const agentId = await working(context);
		await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174001",
			agentId,
		});

		// The turn finished on its own before the interrupt landed. That is a legitimate ending.
		context.relay.handleHostMessage(
			event(context, 1, { kind: "terminal", turnId: "turn-1", state: "completed", finalResponse: "beat it" }),
		);
		await settle();

		const agent = context.agentOf();
		expect(agent?.turns[0]).toMatchObject({ state: "completed", finalResponse: "beat it" });
		expect(agent?.pendingInterrupt).toBeUndefined();
		// The thread stays reusable: stop is an interrupt, not a close.
		expect(agent?.agentState).toBe("idle");
	});

	it("treats a stop on an idle agent as a successful no-op that reaches no daemon", async () => {
		const context = setup();
		const agentId = await working(context);
		context.relay.handleHostMessage(
			event(context, 1, { kind: "terminal", turnId: "turn-1", state: "completed", finalResponse: "done" }),
		);
		await settle();
		context.sent.length = 0;

		const response = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174003",
			agentId,
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(() => CodexAgentResultSchema.parse(body)).not.toThrow();
		expect(body.observation).toBe("idle");
		expect(context.sent.filter((m) => m.kind === "interrupt")).toEqual([]);
	});
});

describe("Codex session isolation", () => {
	it("answers a genuinely foreign agent exactly as it answers a nonexistent one", async () => {
		const context = setup();
		// A real agent, owned by a different session on this same gateway.
		const otherToken = context.otherSession();
		const foreignOperation = "123e4567-e89b-42d3-a456-4266141740ff";
		await context.route.handle(post(otherToken), {
			kind: "start",
			operationId: foreignOperation,
			prompt: "Not yours",
		});
		const foreignAgentId = codexAgentIdForOperation(foreignOperation);

		const foreign = await (
			await context.route.handle(post(context.token), { kind: "await", agentId: foreignAgentId })
		).json();
		const nonexistent = await (
			await context.route.handle(post(context.token), {
				kind: "await",
				agentId: "codex_ffffffffffffffffffffffffffffffff",
			})
		).json();

		// Byte-identical but for the id echoed back: neither answer may reveal that the foreign agent
		// exists, or a caller could probe for other sessions' work.
		expect(foreign.error).toEqual(nonexistent.error);
		expect(foreign.observation).toBe(nonexistent.observation);
		expect(foreign.agentState).toBe(nonexistent.agentState);
		expect(foreign.error?.code).toBe("not_found");
	});

	it("keeps one session's list free of another's agents", async () => {
		const context = setup();
		await working(context);
		const otherToken = context.otherSession();
		await context.route.handle(post(otherToken), {
			kind: "start",
			operationId: "123e4567-e89b-42d3-a456-4266141740fe",
			prompt: "Not yours",
		});

		const mine = await (await context.route.handle(post(context.token), { kind: "list" })).json();
		const theirs = await (await context.route.handle(post(otherToken), { kind: "list" })).json();

		expect(mine.agents).toHaveLength(1);
		expect(theirs.agents).toHaveLength(1);
		expect(mine.agents[0].agentId).not.toBe(theirs.agents[0].agentId);
		expect(theirs.agents[0].latestPromptFirstLine).toBe("Not yours");
	});

	it("refuses a daemon receipt whose owner key names no session", async () => {
		const context = setup();
		await working(context);
		context.relay.handleHostMessage({
			...receipt(context, 9, {
				kind: "accepted",
				operationId: START,
				resolvedTarget: RESOLVED,
				threadId: "thread-1",
				turnId: "turn-9",
				delivery: "started",
			}),
			ownerKey: "someone-else.session",
		});
		await settle();

		expect(context.agentOf()?.turns).toHaveLength(1);
	});
});

describe("Codex recovery", () => {
	it("applies a reliable receipt replayed after a reconnect", async () => {
		const context = setup();
		await context.route.handle(post(context.token), {
			kind: "start",
			operationId: START,
			prompt: "Audit",
		});
		const accepted = receipt(context, 0, {
			kind: "accepted",
			operationId: START,
			resolvedTarget: RESOLVED,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		});

		// The daemon replays what it never saw acknowledged. Applying it twice must not double-count.
		context.relay.handleHostMessage(accepted);
		await settle();
		context.relay.handleHostMessage(accepted);
		await settle();

		const agent = context.agentOf();
		expect(agent?.turns).toHaveLength(1);
		expect(agent?.agentState).toBe("working");
	});

	it("asks about every working record when the daemon reconnects", async () => {
		const context = setup();
		await working(context);
		context.sent.length = 0;

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-2",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});
		await settle();

		expect(context.sent.filter((m) => m.type === "codex_command")).toMatchObject([
			{ kind: "reconcile", threadId: "thread-1", turnId: "turn-1" },
		]);
	});
});
