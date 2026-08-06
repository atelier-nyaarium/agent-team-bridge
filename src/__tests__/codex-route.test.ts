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
	return { route, sent, token, owner, sessionStore, service };
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
			awaitResponse: false,
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
		const body = { kind: "start", operationId: OPERATION_ID, prompt: "Audit", awaitResponse: false };
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
			awaitResponse: false,
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
			awaitResponse: false,
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
			awaitResponse: false,
		});
		const body = await (await context.route.handle(post(context.token), { kind: "list" })).json();

		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].exchanges[0]).toMatchObject({ kind: "start", prompt: "Audit" });
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
