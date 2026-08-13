import { describe, expect, it } from "vitest";
import { CopilotAgentService } from "../gateway/copilotAgentService.js";
import { CopilotRelay } from "../gateway/copilotRelay.js";
import { CopilotRoute } from "../gateway/copilotRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import { CopilotAgentResultSchema, copilotAgentIdForOperation } from "../shared/copilot-thinking.js";
import { type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const START_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const STOP_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174002";

function setup() {
	let catalogWriter: CopilotCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		copilotCatalogPersistence: {
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
	const service = new CopilotAgentService({
		auth,
		sessionStore,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	const sent: Record<string, unknown>[] = [];
	const relay = new CopilotRelay({
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
	const route = new CopilotRoute({ service, relay, waitBudgetMs: 1_000 });
	return { route, relay, sent, owner, token, service, sessionStore };
}

function post(token: string): Request {
	return new Request("http://gateway/copilot", {
		method: "POST",
		headers: { "x-session-token": token },
	});
}

async function flush(): Promise<void> {
	for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function commandFor(context: ReturnType<typeof setup>, operationId: string): Record<string, unknown> {
	const command = context.sent.find(
		(message) => message.type === "copilot_command" && message.operationId === operationId,
	);
	if (!command) throw new Error(`command not found: ${operationId}`);
	return command;
}

async function accept(
	context: ReturnType<typeof setup>,
	operationId: string,
	turnId: string,
	eventId: number,
	delivery: "started" | "followup",
): Promise<void> {
	const command = commandFor(context, operationId);
	context.relay.handleHostMessage({
		type: "copilot_receipt",
		kind: "accepted",
		requestId: command.requestId,
		ownerKey: context.sessionStore.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId: "container:recipe-app",
		generation: 1,
		eventId,
		agentId: command.agentId,
		operationId,
		resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
		sessionId: "session-1",
		turnId,
		delivery,
	});
	await flush();
}

async function terminal(
	context: ReturnType<typeof setup>,
	agentId: string,
	turnId: string,
	eventId: number,
	finalResponse = "Done.",
): Promise<void> {
	context.relay.handleHostMessage({
		type: "copilot_event",
		kind: "terminal",
		ownerKey: context.sessionStore.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId: "container:recipe-app",
		generation: 1,
		eventId,
		agentId,
		sessionId: "session-1",
		turnId,
		state: "completed",
		finalResponse,
	});
	await flush();
}

describe("Copilot gateway route", () => {
	it("returns a terminal result after an accepted ACP turn", async () => {
		const context = setup();
		const agentId = copilotAgentIdForOperation(START_OPERATION_ID);
		const request = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 1,
			agentId,
			sessionId: "session-1",
			turnId: "turn-1",
			itemId: "private-item",
			text: "Checking",
		});
		await flush();
		await terminal(context, agentId, "turn-1", 2);

		const response = await request;
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(() => CopilotAgentResultSchema.parse(body)).not.toThrow();
		expect(body).toMatchObject({
			agentId,
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			activities: [{ kind: "commentary", text: "Checking" }],
			finalResponse: "Done.",
		});
		expect(body.activities[0]).not.toHaveProperty("itemId");
	});

	it("does not let a stale terminal settle a newer turn, and closes a racing stop", async () => {
		const context = setup();
		const agentId = copilotAgentIdForOperation(START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await start;

		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 2, "followup");

		await terminal(context, agentId, "turn-1", 3, "stale");
		expect(context.service.listOwnedAgents(context.owner)[0]).toMatchObject({
			agentState: "working",
			activeTurnId: "turn-2",
		});

		const stop = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: STOP_OPERATION_ID,
			agentId,
		});
		expect(stop.status).toBe(200);
		await terminal(context, agentId, "turn-2", 4);
		await message;

		const agent = context.service.listOwnedAgents(context.owner)[0]!;
		expect(agent.agentState).toBe("idle");
		expect(agent.operations.find((operation) => operation.operationId === STOP_OPERATION_ID)?.state).toBe(
			"accepted",
		);
	});
});
