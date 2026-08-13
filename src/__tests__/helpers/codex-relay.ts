import { CodexAgentService } from "../../gateway/codexAgentService.js";
import { CodexRelay } from "../../gateway/codexRelay.js";
import { createSessionAuthority } from "../../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../../gateway/websocket.js";
import { type CodexCatalogWriter, SessionStore } from "../../shared/session-store.js";

////////////////////////////////
//  Constants

export const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
export const START_OPERATION = "123e4567-e89b-42d3-a456-426614174000";
export const STOP_OPERATION = "123e4567-e89b-42d3-a456-426614174009";
export const TARGET_ID = "container:recipe-app";
export const DEVCONTAINER_TARGET = {
	kind: "devcontainer",
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
} as const;
export const RESOLVED_TARGET = { kind: "devcontainer" as const, targetId: TARGET_ID, cwd: "/workspace/recipe-app" };

////////////////////////////////
//  Functions & Helpers

export function setup() {
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
export function working(context: ReturnType<typeof setup>) {
	context.service.beginStart(context.request, {
		agentId: AGENT_ID,
		operationId: START_OPERATION,
		prompt: "Audit the parser",
		target: DEVCONTAINER_TARGET,
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

export function eventBase(ownerKey: string, eventId: number) {
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

export function currentAgent(context: ReturnType<typeof setup>) {
	return context.sessionStore.listCodexAgents(context.owner)[0]!;
}

export function receiptBase(ownerKey: string, eventId: number) {
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
export async function settleRelay() {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}
