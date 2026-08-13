import { describe, expect, it } from "vitest";
import type { CopilotAgentService, CopilotApplication } from "../gateway/copilotAgentService.js";
import { CopilotRelay } from "../gateway/copilotRelay.js";
import {
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	CopilotDaemonHelloSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	CopilotEventAckSchema,
	type CopilotPersistedAgent,
	CopilotPersistedAgentSchema,
} from "../shared/copilot-thinking.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const DAEMON_INSTANCE_ID = "daemon-1";
const TARGET_ID = "container:recipe-app";
const GENERATION = 1;
const SESSION_ID = "session-1";
const TURN_ID = "turn-1";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const RESOLVED_TARGET = { kind: "devcontainer" as const, targetId: TARGET_ID, cwd: "/workspace/recipe-app" };
const REQUESTED_TARGET = {
	kind: "devcontainer" as const,
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
};

const OWNER: SessionRecord = { id: "work", sessionLabel: "Work", spawn: "recipe-app", lastSeen: 0 };

type ApplicationFactory = (
	owner: SessionRecord,
	agent: CopilotPersistedAgent,
	message: CopilotDaemonEvent | CopilotDaemonReceipt,
) => CopilotApplication;

interface SetupOptions {
	agent?: CopilotPersistedAgent;
	onEvent?: ApplicationFactory;
	onReceipt?: ApplicationFactory;
	attached?: boolean;
}

function applied(owner: SessionRecord, agent: CopilotPersistedAgent): CopilotApplication {
	return { disposition: "applied", owner, agent, catalogRevision: 1 };
}

function reconcile(owner: SessionRecord, agent: CopilotPersistedAgent): CopilotApplication {
	return { disposition: "reconcile", owner, agent };
}

function askableAgent(agentState: "working" | "idle" = "working"): CopilotPersistedAgent {
	return CopilotPersistedAgentSchema.parse({
		version: 1,
		agentId: AGENT_ID,
		agentState,
		requestedTarget: REQUESTED_TARGET,
		resolvedTarget: RESOLVED_TARGET,
		sessionId: SESSION_ID,
		...(agentState === "working" ? { activeTurnId: TURN_ID } : {}),
		operations: [],
		turns: [],
		createdAt: 0,
		updatedAt: 0,
	});
}

function agentWithoutSession(): CopilotPersistedAgent {
	return CopilotPersistedAgentSchema.parse({
		version: 1,
		agentId: AGENT_ID,
		agentState: "creating",
		requestedTarget: REQUESTED_TARGET,
		operations: [],
		turns: [],
		createdAt: 0,
		updatedAt: 0,
	});
}

function eventFrame(eventId: number, kind: "activity" | "terminal" = "activity"): CopilotDaemonEvent {
	if (kind === "activity")
		return CopilotDaemonEventSchema.parse({
			type: "copilot_event",
			kind,
			ownerKey: OWNER_KEY,
			daemonInstanceId: DAEMON_INSTANCE_ID,
			targetId: TARGET_ID,
			generation: GENERATION,
			eventId,
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			turnId: TURN_ID,
			itemId: `item-${eventId}`,
			text: "activity",
		});
	return CopilotDaemonEventSchema.parse({
		type: "copilot_event",
		kind,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		state: "completed",
		finalResponse: "done",
	});
}

function acceptedReceipt(eventId: number): CopilotDaemonReceipt {
	return CopilotDaemonReceiptSchema.parse({
		type: "copilot_receipt",
		kind: "accepted",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		operationId: REQUEST_ID,
		resolvedTarget: RESOLVED_TARGET,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		delivery: "started",
	});
}

function reconciledReceipt(eventId: number): CopilotDaemonReceipt {
	return CopilotDaemonReceiptSchema.parse({
		type: "copilot_receipt",
		kind: "reconciled",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		sessionId: SESSION_ID,
		active: false,
	});
}

function helloFrame() {
	return CopilotDaemonHelloSchema.parse({
		type: "copilot_hello",
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targets: [{ targetId: TARGET_ID, generation: GENERATION }],
	});
}

function setup(options: SetupOptions = {}) {
	let agent = options.agent ?? askableAgent();
	let attached = options.attached ?? true;
	const sent: Record<string, unknown>[] = [];
	const eventCalls: CopilotDaemonEvent[] = [];
	const receiptCalls: CopilotDaemonReceipt[] = [];
	const sessionStore = {
		list: () => [OWNER],
		teamOf: (record: SessionRecord) => `${record.spawn}.${record.id}`,
	} as unknown as SessionStore;
	const service = {
		listOwnedAgents: () => [agent],
		applyEvent: (event: CopilotDaemonEvent) => {
			eventCalls.push(event);
			return options.onEvent?.(OWNER, agent, event) ?? applied(OWNER, agent);
		},
		applyReceipt: (receipt: CopilotDaemonReceipt) => {
			receiptCalls.push(receipt);
			return options.onReceipt?.(OWNER, agent, receipt) ?? applied(OWNER, agent);
		},
	} as unknown as CopilotAgentService;
	const relay = new CopilotRelay({
		service,
		sessionStore,
		sendToHost: (message) => {
			if (!attached) return false;
			sent.push(message);
			return true;
		},
	});
	return {
		relay,
		sent,
		eventCalls,
		receiptCalls,
		setAgent: (next: CopilotPersistedAgent) => {
			agent = next;
		},
		setAttached: (next: boolean) => {
			attached = next;
		},
	};
}

async function settleRelay(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function messagesOf(context: ReturnType<typeof setup>, type: string): Record<string, unknown>[] {
	return context.sent.filter((message) => message.type === type);
}

describe("Copilot relay acknowledgement", () => {
	it("sends a strict-schema ack for a decided event", async () => {
		const context = setup();
		const frame = eventFrame(7);

		context.relay.handleHostMessage(frame);
		await settleRelay();

		const parsed = CopilotEventAckSchema.safeParse(messagesOf(context, "copilot_ack")[0]);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.throughEventId).toBe(frame.eventId);
	});

	it("acknowledges a reconcile result for an agent without a session", async () => {
		const context = setup({
			agent: agentWithoutSession(),
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(3));
		await settleRelay();

		expect(messagesOf(context, "copilot_ack")).toHaveLength(1);
		expect(messagesOf(context, "copilot_ack")[0]?.throughEventId).toBe(3);
		expect(messagesOf(context, "copilot_command")).toEqual([]);
	});

	it("holds a reconcile result for an askable agent", async () => {
		const context = setup({
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(4));
		await settleRelay();

		expect(messagesOf(context, "copilot_ack")).toEqual([]);
		const commands = messagesOf(context, "copilot_command");
		expect(commands).toHaveLength(1);
		expect(CopilotDaemonCommandSchema.safeParse(commands[0]).success).toBe(true);
		expect(commands[0]).toMatchObject({
			kind: "reconcile",
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			sessionId: SESSION_ID,
		});
	});

	it("releases a held event when reconciliation applies", async () => {
		let hold = true;
		const context = setup({
			onEvent: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
		});

		context.relay.handleHostMessage(eventFrame(4));
		await settleRelay();
		hold = false;
		context.relay.handleHostMessage(reconciledReceipt(5));
		await settleRelay();

		const acks = messagesOf(context, "copilot_ack");
		expect(acks.at(-1)?.throughEventId).toBe(5);
		expect(acks.some((ack) => (ack.throughEventId as number) >= 4)).toBe(true);
	});

	it("evicts activity before terminal and receipt frames", async () => {
		let hold = true;
		const context = setup({
			onEvent: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
			onReceipt: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
		});

		// The terminal is OLDEST on purpose: an oldest-first eviction would drop it, activity-first keeps it.
		context.relay.handleHostMessage(eventFrame(1, "terminal"));
		for (let eventId = 2; eventId <= 130; eventId += 1) context.relay.handleHostMessage(eventFrame(eventId));
		context.relay.handleHostMessage(acceptedReceipt(131));
		await settleRelay();
		const eventCallsBeforeDrain = context.eventCalls.length;
		const receiptCallsBeforeDrain = context.receiptCalls.length;

		hold = false;
		context.relay.handleHostMessage(reconciledReceipt(132));
		await settleRelay();

		const replayedEvents = context.eventCalls.slice(eventCallsBeforeDrain);
		const replayedReceipts = context.receiptCalls.slice(receiptCallsBeforeDrain);
		const replayedActivities = replayedEvents
			.filter((event) => event.kind === "activity")
			.map((event) => event.eventId);
		expect(replayedActivities).toHaveLength(126);
		expect(replayedActivities.every((eventId) => eventId >= 5)).toBe(true);
		expect(replayedEvents).toContainEqual(expect.objectContaining({ kind: "terminal", eventId: 1 }));
		expect(replayedReceipts).toContainEqual(expect.objectContaining({ kind: "accepted", eventId: 131 }));
	});

	it("reasks for deferred work when hello sees an idle agent", async () => {
		const context = setup({
			attached: false,
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(1));
		await settleRelay();
		context.setAttached(true);
		context.setAgent(askableAgent("idle"));
		context.relay.handleHostMessage(helloFrame());
		await settleRelay();

		const commands = messagesOf(context, "copilot_command");
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ kind: "reconcile", agentId: AGENT_ID });
	});
});
