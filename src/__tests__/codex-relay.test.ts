import { describe, expect, it } from "vitest";
import { CodexAgentService, CodexTransitionError } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import type { CodexDaemonEvent, CodexDaemonReceipt } from "../shared/codex-thinking.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const START_OPERATION = "123e4567-e89b-42d3-a456-426614174000";
const STOP_OPERATION = "123e4567-e89b-42d3-a456-426614174009";
const TARGET_ID = "container:recipe-app";
const RESOLVED_TARGET = { kind: "devcontainer" as const, targetId: TARGET_ID, cwd: "/workspace/recipe-app" };

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
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const request = new Request("http://gateway/codex", { headers: { "x-session-token": token } });
	const sent: Record<string, unknown>[] = [];
	// Mutable so a test can take the host away mid-run, which is the state the relay must not read as
	// a fact about the record.
	const host = { attached: true };
	const relay = new CodexRelay({
		service,
		sessionStore,
		sendToHost: (message) => {
			if (!host.attached) return false;
			sent.push(message);
			return true;
		},
	});
	return {
		service,
		relay,
		request,
		sessionStore,
		owner,
		ownerKey: sessionStore.teamOf(owner),
		sent,
		set attached(value: boolean) {
			host.attached = value;
		},
	};
}

/** An agent whose start has been accepted, so it holds a thread, an active turn, and a fence. */
function working(context: ReturnType<typeof setup>) {
	context.service.beginStart(context.request, {
		agentId: AGENT_ID,
		operationId: START_OPERATION,
		prompt: "Audit the parser",
		at: 10,
	});
	context.service.acceptDelivery(context.request, {
		agentId: AGENT_ID,
		operationId: START_OPERATION,
		resolvedTarget: RESOLVED_TARGET,
		threadId: "thread-1",
		turnId: "turn-1",
		delivery: "started",
		fence: { daemonInstanceId: "daemon-1", targetId: TARGET_ID, generation: 1, lastEventId: 0 },
		at: 11,
	});
	return context;
}

function eventBase(ownerKey: string, eventId: number) {
	return {
		type: "codex_event" as const,
		ownerKey,
		daemonInstanceId: "daemon-1",
		targetId: TARGET_ID,
		generation: 1,
		eventId,
		agentId: AGENT_ID,
		threadId: "thread-1",
		turnId: "turn-1",
	};
}

function currentAgent(context: ReturnType<typeof setup>) {
	return context.sessionStore.listCodexAgents(context.owner)[0]!;
}

function receiptBase(ownerKey: string, eventId: number) {
	return {
		type: "codex_receipt" as const,
		requestId: "123e4567-e89b-42d3-a456-4266141740aa",
		ownerKey,
		daemonInstanceId: "daemon-1",
		targetId: TARGET_ID,
		generation: 1,
		eventId,
		agentId: AGENT_ID,
	};
}

/** Let the relay's per-agent chain drain. Each frame costs a tick, and a drain re-runs held ones. */
async function settleRelay() {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

describe("Codex daemon event application", () => {
	it("settles the active turn on a completed terminal", () => {
		const context = working(setup());
		const applied = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "391" },
			20,
		);

		expect(applied.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.agentState).toBe("idle");
		expect(agent.activeTurnId).toBeUndefined();
		expect(agent.turns[0]).toMatchObject({ state: "completed", finalResponse: "391" });
		expect(agent.fence?.lastEventId).toBe(1);
	});

	it("retains commentary once per item and refuses a repeat of the same item", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "activity", itemId: "item-1", text: "reading" },
			20,
		);
		const repeat = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 2), kind: "activity", itemId: "item-1", text: "reading" },
			21,
		);

		expect(repeat.disposition).toBe("ignored");
		expect(currentAgent(context).turns[0]?.activities).toEqual([
			{ kind: "commentary", itemId: "item-1", text: "reading" },
		]);
	});

	it("ignores an event that does not advance the fence", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 3), kind: "activity", itemId: "item-1", text: "reading" },
			20,
		);
		const stale = context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 3), kind: "activity", itemId: "item-2", text: "still reading" },
			21,
		);

		expect(stale.disposition).toBe("ignored");
		expect(currentAgent(context).turns[0]?.activities).toHaveLength(1);
	});

	it("asks for reconciliation rather than applying an event from another generation", () => {
		const context = working(setup());
		const foreign = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 1),
				generation: 2,
				kind: "terminal",
				state: "completed",
				finalResponse: "done",
			},
			20,
		);

		expect(foreign.disposition).toBe("reconcile");
		expect(currentAgent(context).agentState).toBe("working");
	});

	it("refuses an event naming a thread the agent does not hold", () => {
		const context = working(setup());
		const wrong = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 1),
				threadId: "thread-other",
				kind: "terminal",
				state: "completed",
				finalResponse: "done",
			},
			20,
		);

		expect(wrong.disposition).toBe("ignored");
		expect(currentAgent(context).agentState).toBe("working");
	});
});

describe("Codex daemon receipt application", () => {
	function stopping(context: ReturnType<typeof setup>) {
		context.service.beginStop(context.request, { agentId: AGENT_ID, operationId: STOP_OPERATION, at: 12 });
		return context;
	}

	it("keeps the interrupt pending until the turn's own terminal lands", () => {
		const context = stopping(working(setup()));
		const delivered = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 1),
				kind: "interruptResult",
				operationId: STOP_OPERATION,
				threadId: "thread-1",
				turnId: "turn-1",
				ok: true,
			},
			20,
		);

		expect(delivered.disposition).toBe("applied");
		expect(currentAgent(context).pendingInterrupt).toBeDefined();

		context.service.applyEvent({ ...eventBase(context.ownerKey, 2), kind: "terminal", state: "interrupted" }, 21);
		const agent = currentAgent(context);
		expect(agent.pendingInterrupt).toBeUndefined();
		expect(agent.turns[0]?.state).toBe("interrupted");
	});

	it("settles a stop that lost the race to completion", () => {
		const context = stopping(working(setup()));
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "done" },
			20,
		);

		const agent = currentAgent(context);
		expect(agent.turns[0]?.state).toBe("completed");
		expect(agent.operations.find((operation) => operation.kind === "stop")?.state).toBe("accepted");
		expect(agent.pendingInterrupt).toBeUndefined();
	});

	it("clears the pending interrupt when the daemon could not deliver it", () => {
		const context = stopping(working(setup()));
		const failed = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 1),
				kind: "interruptFailed",
				operationId: STOP_OPERATION,
				threadId: "thread-1",
				turnId: "turn-1",
				ok: false,
				error: "app server exited",
			},
			20,
		);

		expect(failed.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.pendingInterrupt).toBeUndefined();
		expect(agent.operations.find((operation) => operation.kind === "stop")?.state).toBe("indeterminate");
	});

	it("marks a refused start unavailable rather than leaving it being created", () => {
		const context = setup();
		context.service.beginStart(context.request, {
			agentId: AGENT_ID,
			operationId: START_OPERATION,
			prompt: "Audit",
			at: 10,
		});
		const refused = context.service.applyReceipt(
			{
				type: "codex_receipt",
				kind: "rejected",
				requestId: "123e4567-e89b-42d3-a456-4266141740aa",
				ownerKey: context.ownerKey,
				daemonInstanceId: "daemon-1",
				eventId: 1,
				agentId: AGENT_ID,
				operationId: START_OPERATION,
				error: "execution target is unavailable",
			},
			20,
		);

		expect(refused.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.agentState).toBe("unavailable");
		expect(agent.exchanges[0]?.status).toBe("indeterminate");
	});

	it("records a steer whose receipt was overtaken by its own turn's terminal", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-42661417400a";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Also check the lexer",
			at: 12,
		});
		// The terminal wins the race to the gateway, which is what the transport's own ordering used to
		// guarantee: a reply only schedules its continuation, while a notification fired inline.
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "both" },
			13,
		);

		const accepted = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				delivery: "steered",
			},
			14,
		);

		expect(accepted.disposition).toBe("applied");
		const agent = currentAgent(context);
		// The delivery is recorded against the turn that answered it, and that turn stays settled.
		expect(agent.exchanges.at(-1)).toMatchObject({ delivery: "steered", turnId: "turn-1", status: "accepted" });
		expect(agent.turns[0]?.state).toBe("completed");
		expect(agent.activeTurnId).toBeUndefined();
		expect(agent.agentState).toBe("idle");
	});

	it("settles a delivery it refuses instead of leaving the agent wedged", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-42661417400b";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 12,
		});

		// A delivery naming a turn this record has never seen, while its own turn is still running.
		const refused = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-9",
				delivery: "started",
			},
			14,
		);

		expect(refused.disposition).toBe("ignored");
		const agent = currentAgent(context);
		expect(agent.operations.at(-1)?.state).toBe("indeterminate");
		expect(agent.agentState).toBe("recovering");
	});

	it("holds a refused message in recovery so a second prompt cannot follow it", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174007";
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "first" },
			13,
		);
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 14,
		});

		context.service.applyReceipt(
			{
				type: "codex_receipt",
				kind: "rejected",
				requestId: "123e4567-e89b-42d3-a456-4266141740aa",
				ownerKey: context.ownerKey,
				daemonInstanceId: "daemon-1",
				eventId: 2,
				agentId: AGENT_ID,
				operationId: MESSAGE_OPERATION,
				error: "codex thread produced no turn",
			},
			15,
		);

		// The daemon can only prove non-delivery as far as it could read, so the agent waits for
		// reconciliation rather than accepting another prompt that might run the same work twice.
		expect(currentAgent(context).agentState).toBe("recovering");
		expect(() =>
			context.service.beginMessage(context.request, {
				agentId: AGENT_ID,
				operationId: "123e4567-e89b-42d3-a456-426614174008",
				prompt: "Continue again",
				at: 16,
			}),
		).toThrowError(CodexTransitionError);
	});

	it("re-fences a reconciled agent so the terminal that follows applies", () => {
		const context = working(setup());
		const reconciled = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 5),
				generation: 4,
				kind: "reconciled",
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "completed",
			},
			20,
		);

		expect(reconciled.disposition).toBe("applied");
		expect(currentAgent(context).agentState).toBe("recovering");

		const terminal = context.service.applyEvent(
			{
				...eventBase(context.ownerKey, 6),
				generation: 4,
				kind: "terminal",
				state: "completed",
				finalResponse: "recovered",
			},
			21,
		);
		expect(terminal.disposition).toBe("applied");
		expect(currentAgent(context).turns[0]).toMatchObject({ state: "completed", finalResponse: "recovered" });
	});

	it("accepts a new turn for a message whose steered turn finished during delivery", () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174005";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Also check the lexer",
			at: 12,
		});
		// The turn the message was aimed at ends before the daemon's steer lands.
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "first" },
			13,
		);

		const accepted = context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 2),
				kind: "accepted",
				operationId: MESSAGE_OPERATION,
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-2",
				delivery: "started",
			},
			14,
		);

		expect(accepted.disposition).toBe("applied");
		const agent = currentAgent(context);
		expect(agent.activeTurnId).toBe("turn-2");
		expect(agent.exchanges.at(-1)).toMatchObject({ delivery: "started", turnId: "turn-2" });
	});

	it("withholds acknowledgement of an acceptance it could not place", async () => {
		const context = working(setup());
		const MESSAGE_OPERATION = "123e4567-e89b-42d3-a456-426614174006";
		context.service.beginMessage(context.request, {
			agentId: AGENT_ID,
			operationId: MESSAGE_OPERATION,
			prompt: "Continue",
			at: 12,
		});
		context.sent.length = 0;

		context.relay.handleHostMessage({
			...receiptBase(context.ownerKey, 4),
			generation: 9,
			kind: "accepted",
			operationId: MESSAGE_OPERATION,
			resolvedTarget: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "steered",
		});
		await settleRelay();

		expect(context.sent.filter((message) => message.type === "codex_ack")).toEqual([]);
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile" },
		]);
	});

	it("asks again after a refused reconcile instead of going quiet for good", async () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});
		await settleRelay();
		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(1);

		// The daemon cannot reach the target. A refused reconcile carries no operationId at all.
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "rejected",
			requestId: "123e4567-e89b-42d3-a456-4266141740bb",
			ownerKey: context.ownerKey,
			daemonInstanceId: "daemon-1",
			eventId: 1,
			agentId: AGENT_ID,
			error: "execution target is unavailable",
		});
		await settleRelay();

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 2 }],
		});
		await settleRelay();

		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(2);
	});

	it("returns a survived turn to working", () => {
		const context = working(setup());
		context.service.applyReceipt(
			{
				...receiptBase(context.ownerKey, 5),
				generation: 4,
				kind: "reconciled",
				resolvedTarget: RESOLVED_TARGET,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "inProgress",
			},
			20,
		);

		expect(currentAgent(context).agentState).toBe("working");
	});
});

describe("Codex relay keying", () => {
	it("keeps two agents whose names concatenate identically apart", async () => {
		const context = working(setup());
		// "recipe-app.work" + "codex_aa..." vs "recipe-app.workcodex_aa..." + "" is the collision a bare
		// join allows. A separator that cannot appear inside either field is what rules it out.
		const shifted = `${context.ownerKey}x`;
		context.relay.handleHostMessage({
			...eventBase(shifted, 1),
			kind: "terminal",
			state: "completed",
			finalResponse: "not mine",
		} as unknown as CodexDaemonEvent);
		await settleRelay();

		// The real agent is untouched: the event named an owner that does not exist.
		expect(currentAgent(context).agentState).toBe("working");
		expect(currentAgent(context).turns[0]?.state).toBe("inProgress");
	});
});

describe("Codex relay acknowledgement", () => {
	function frame(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
		return { ...eventBase(context.ownerKey, eventId), ...extra } as unknown as CodexDaemonEvent;
	}

	const settle = settleRelay;

	it("acknowledges through an applied event", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await Promise.resolve();

		expect(context.sent).toContainEqual({
			type: "codex_ack",
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 1,
			throughEventId: 1,
		});
	});

	it("withholds acknowledgement at and above an event it could not decide", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		context.relay.handleHostMessage(frame(context, 2, { kind: "activity", itemId: "item-2", text: "more" }));
		await Promise.resolve();
		await Promise.resolve();

		const acks = context.sent.filter((message) => message.type === "codex_ack");
		expect(acks).toEqual([]);
		expect(context.sent.filter((message) => message.type === "codex_command")).toHaveLength(1);
	});

	it("asks for reconciliation once per agent no matter how many events stall", async () => {
		const context = working(setup());
		for (const eventId of [1, 2, 3]) {
			context.relay.handleHostMessage(
				frame(context, eventId, {
					turnId: "turn-unknown",
					kind: "activity",
					itemId: `item-${eventId}`,
					text: "x",
				}),
			);
		}
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const commands = context.sent.filter((message) => message.type === "codex_command");
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ kind: "reconcile", agentId: AGENT_ID, threadId: "thread-1" });
	});

	it("releases the acknowledgement it withheld once reconciliation decides the held events", async () => {
		const context = working(setup());
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		context.relay.handleHostMessage(frame(context, 2, { kind: "activity", itemId: "item-2", text: "more" }));
		await settle();
		// Event 2 applied, but the ack floor stays below the undecided event 1 rather than skipping it.
		for (const ack of context.sent.filter((message) => message.type === "codex_ack")) {
			expect(ack.throughEventId as number).toBeLessThan(1);
		}

		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "reconciled",
			requestId: "123e4567-e89b-42d3-a456-4266141740aa",
			ownerKey: context.ownerKey,
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 1,
			eventId: 3,
			agentId: AGENT_ID,
			resolvedTarget: RESOLVED_TARGET,
			threadId: "thread-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await settle();

		// The held event is decided (its turn does not exist, so it is refused), which is what lets the
		// stream advance past it instead of stalling for the life of the generation.
		const acks = context.sent.filter((message) => message.type === "codex_ack");
		expect(acks.at(-1)).toMatchObject({ throughEventId: 3 });
	});

	it("asks about a held frame on reconnect even after its agent has gone idle", async () => {
		const context = working(setup());
		context.attached = false;
		// Held, but the ask never left the socket.
		context.relay.handleHostMessage(
			frame(context, 1, { turnId: "turn-unknown", kind: "activity", itemId: "item-1", text: "reading" }),
		);
		await settle();

		context.attached = true;
		// The agent's real turn ends normally, so the record is idle and no longer "needs" reconciling.
		context.relay.handleHostMessage(
			frame(context, 2, { kind: "terminal", state: "completed", finalResponse: "done" }),
		);
		await settle();
		expect(currentAgent(context).agentState).toBe("idle");
		context.sent.length = 0;

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});
		await settle();

		// Without this, the hold caps the acknowledgement for every agent on this target forever.
		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile", agentId: AGENT_ID },
		]);
	});

	it("never acknowledges a frame it could not turn into a record", async () => {
		const context = working(setup());
		// A reducer that cannot build a valid record reports `failed`. That is a fact about the gateway,
		// not about the frame, so acknowledging it would make the daemon delete the only copy of this
		// turn's outcome. Stubbed because the natural triggers are schema edges, and the invariant under
		// test belongs to the relay rather than to any one of them.
		const stub = {
			...context.service,
			applyEvent: () => ({ disposition: "failed" as const, reason: "stubbed reducer failure" }),
		} as unknown as CodexAgentService;
		const sent: Record<string, unknown>[] = [];
		const relay = new CodexRelay({
			service: stub,
			sessionStore: context.sessionStore,
			sendToHost: (message) => {
				sent.push(message);
				return true;
			},
		});

		relay.handleHostMessage({
			...eventBase(context.ownerKey, 1),
			kind: "terminal",
			state: "completed",
			finalResponse: "the only copy",
		});
		await settleRelay();

		expect(sent.filter((message) => message.type === "codex_ack")).toEqual([]);
	});

	it("re-sends an acknowledgement whose first attempt never left the socket", async () => {
		const context = working(setup());
		context.attached = false;
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await settle();
		expect(context.sent).toEqual([]);

		// The daemon reconnects and replays what it still holds. A watermark advanced on the failed send
		// would suppress this as already-acknowledged, and a quiet stream would never recover.
		context.attached = true;
		context.relay.handleHostMessage(frame(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		await settle();

		expect(context.sent.filter((message) => message.type === "codex_ack")).toMatchObject([{ throughEventId: 1 }]);
	});

	it("reconciles every record its owner still believes is working when the daemon reconnects", () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-2",
			targets: [{ targetId: TARGET_ID, generation: 1 }],
		});

		expect(context.sent.filter((message) => message.type === "codex_command")).toMatchObject([
			{ kind: "reconcile", agentId: AGENT_ID, threadId: "thread-1", turnId: "turn-1" },
		]);
	});

	it("does not reconcile an idle record", () => {
		const context = working(setup());
		context.service.applyEvent(
			{ ...eventBase(context.ownerKey, 1), kind: "terminal", state: "completed", finalResponse: "done" },
			20,
		);
		context.sent.length = 0;

		context.relay.handleHostMessage({
			type: "codex_hello",
			daemonInstanceId: "daemon-2",
			targets: [],
		});

		expect(context.sent).toEqual([]);
	});

	it("refuses a receipt that fails validation before it reaches the reducer", async () => {
		const context = working(setup());
		context.relay.handleHostMessage({
			type: "codex_receipt",
			kind: "accepted",
			requestId: "not-a-uuid",
			ownerKey: context.ownerKey,
			agentId: AGENT_ID,
		} as unknown as CodexDaemonReceipt);
		await Promise.resolve();

		expect(context.sent).toEqual([]);
		expect(currentAgent(context).agentState).toBe("working");
	});
});
