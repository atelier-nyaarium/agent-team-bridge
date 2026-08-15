import { describe, expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation } from "../gateway/websocket.js";
import {
	CodexAgentCatalogSchema,
	type CodexPersistedAgent,
	codexOperationFingerprint,
	restoreCodexAgentCatalog,
} from "../shared/codex-agent.js";
import { DurableStoreInstalledError } from "../shared/durable-store.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";
import { AGENT_ID, OPERATION_ID, requestedAgent } from "./helpers/codex-agent.js";

const OTHER_AGENT_ID = "codex_ffffffffffffffffffffffffffffffff";
const OTHER_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const DEVCONTAINER_TARGET = {
	kind: "devcontainer",
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
} as const;

function storeWithCatalogWriter(persistChecked: () => void = () => {}) {
	let catalogWriter: CodexCatalogWriter | undefined;
	const store = new SessionStore({
		codexCatalogPersistence: {
			persistChecked,
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	return { store, catalogWriter };
}

describe("session-owned Codex catalog", () => {
	it("rejects owner-wide agent and operation collisions", () => {
		const first = requestedAgent();
		const duplicateAgent = requestedAgent(AGENT_ID, OTHER_OPERATION_ID);
		const duplicateOperation = requestedAgent(OTHER_AGENT_ID, OPERATION_ID);

		expect(CodexAgentCatalogSchema.safeParse({ version: 1, revision: 0, agents: [first] }).success).toBe(true);
		expect(
			CodexAgentCatalogSchema.safeParse({ version: 1, revision: 0, agents: [first, duplicateAgent] }).success,
		).toBe(false);
		expect(
			CodexAgentCatalogSchema.safeParse({ version: 1, revision: 0, agents: [first, duplicateOperation] }).success,
		).toBe(false);
	});

	it("drops malformed and ambiguous agents while preserving valid siblings", () => {
		const valid = requestedAgent();
		const collisionA = requestedAgent(OTHER_AGENT_ID, OTHER_OPERATION_ID);
		const collisionB = requestedAgent("codex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OTHER_OPERATION_ID);
		const restored = restoreCodexAgentCatalog({
			version: 1,
			revision: 7,
			agents: [valid, { broken: true }, collisionA, collisionB],
		});

		expect(restored).toEqual({ version: 1, revision: 7, agents: [valid] });
	});

	it("contains an invalid catalog revision instead of throwing during restore", () => {
		expect(() =>
			restoreCodexAgentCatalog({ version: 1, revision: Number.MAX_VALUE, agents: [requestedAgent()] }),
		).not.toThrow();
		expect(
			restoreCodexAgentCatalog({ version: 1, revision: Number.MAX_VALUE, agents: [requestedAgent()] }),
		).toBeUndefined();
	});

	it("restores valid nested entries without sacrificing an owner to damaged entries", () => {
		const store = new SessionStore();
		store.restore({
			"recipe-app.owner": {
				id: "owner",
				sessionLabel: "Owner",
				spawn: "recipe-app",
				confirmedAt: 10,
				lastSeen: 10,
				codexCatalog: { version: 1, revision: 3, agents: [requestedAgent(), { broken: true }] },
			},
		});

		const owner = store.getByTeam("recipe-app.owner");
		expect(owner).toBeDefined();
		expect(store.codexCatalog(owner!)).toEqual({ version: 1, revision: 3, agents: [requestedAgent()] });
	});

	it("migrates recovery intents written before pre-dispatch snapshots were added", () => {
		const legacy = structuredClone(requestedAgent()) as unknown as {
			operations: Array<Record<string, unknown>>;
		};
		delete legacy.operations[0]!.preDispatch;

		expect(restoreCodexAgentCatalog({ version: 1, revision: 2, agents: [legacy] })).toMatchObject({
			version: 1,
			revision: 2,
			agents: [{ operations: [{ preDispatch: { agentState: "creating" } }] }],
		});
	});

	it("marks legacy accepted deliveries without receipt fences for reconciliation", () => {
		const legacy = requestedAgent() as unknown as Record<string, unknown> & {
			exchanges: Array<Record<string, unknown>>;
			operations: Array<Record<string, unknown>>;
		};
		legacy.agentState = "idle";
		legacy.resolvedTarget = { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" };
		legacy.threadId = "thread-1";
		legacy.turns = [{ id: "turn-1", state: "completed", activities: [], finalResponse: "Done", updatedAt: 13 }];
		legacy.exchanges[0] = {
			...legacy.exchanges[0],
			status: "accepted",
			delivery: "started",
			turnId: "turn-1",
			acceptedAt: 11,
		};
		legacy.operations[0] = {
			...legacy.operations[0],
			state: "accepted",
			turnId: "turn-1",
			updatedAt: 11,
		};
		legacy.exchanges.push({
			exchangeId: OTHER_OPERATION_ID,
			operationId: OTHER_OPERATION_ID,
			kind: "message",
			prompt: "Continue",
			status: "accepted",
			delivery: "steered",
			turnId: "turn-1",
			createdAt: 12,
			acceptedAt: 12,
		});
		legacy.operations.push({
			operationId: OTHER_OPERATION_ID,
			kind: "message",
			fingerprint: codexOperationFingerprint("message", AGENT_ID, "Continue"),
			state: "accepted",
			turnId: "turn-1",
			expectedTurnId: "turn-1",
			createdAt: 12,
			updatedAt: 12,
		});
		legacy.updatedAt = 13;

		const catalog = restoreCodexAgentCatalog({ version: 1, revision: 2, agents: [legacy] });
		expect(catalog).toMatchObject({
			agents: [
				{
					agentState: "recovering",
					operations: [
						{ acceptanceUnverified: true },
						{
							acceptanceUnverified: true,
							preDispatch: { agentState: "working", threadId: "thread-1", turnId: "turn-1" },
						},
					],
				},
			],
		});

		const { store, catalogWriter } = storeWithCatalogWriter();
		store.restore({
			"recipe-app.owner": {
				id: "owner",
				sessionLabel: "Owner",
				spawn: "recipe-app",
				bindToken: "owner-token",
				bindActiveAt: 1,
				confirmedAt: 1,
				lastSeen: 12,
				codexCatalog: catalog,
			},
		});
		const auth = createSessionAuthority({
			sessionStore: store,
			registry: new Map(),
			resolveLive: resolveLiveIncarnation,
			localDomainId: () => "alice",
			localGatewayId: "sakura",
		});
		const service = new CodexAgentService({
			auth,
			sessionStore: store,
			offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
			catalogWriter,
		});
		const request = new Request("http://gateway/codex", {
			headers: { "x-session-token": "owner-token" },
		});
		expect(
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				target: DEVCONTAINER_TARGET,
				at: 13,
			}).disposition,
		).toBe("indeterminate");
	});

	it("rolls back the in-memory catalog when its checked commit fails", () => {
		const { store, catalogWriter } = storeWithCatalogWriter(() => {
			throw new Error("disk unavailable");
		});
		const owner = store.mint({ spawn: "recipe-app" });

		expect(() => catalogWriter.commit(owner, 0, [requestedAgent()])).toThrow("disk unavailable");
		expect(store.codexCatalog(owner)).toBeUndefined();
	});

	it("retains an installed catalog when only durability confirmation fails", () => {
		const { store, catalogWriter } = storeWithCatalogWriter(() => {
			throw new DurableStoreInstalledError(new Error("directory sync unavailable"));
		});
		const owner = store.mint({ spawn: "recipe-app" });

		expect(() => catalogWriter.commit(owner, 0, [requestedAgent()])).toThrow(DurableStoreInstalledError);
		expect(store.codexCatalog(owner)).toMatchObject({ revision: 1, agents: [{ agentState: "creating" }] });
	});

	it("returns detached catalog reads and snapshots", () => {
		const { store, catalogWriter } = storeWithCatalogWriter();
		const owner = store.mint({ spawn: "recipe-app" });
		catalogWriter.commit(owner, 0, [requestedAgent()]);
		const listed = store.listCodexAgents(owner) as CodexPersistedAgent[];
		const snapshot = store.snapshot();

		listed[0]!.exchanges[0]!.prompt = "mutated read";
		snapshot[store.teamOf(owner)]!.codexCatalog!.agents[0]!.exchanges[0]!.prompt = "mutated snapshot";

		expect(store.listCodexAgents(owner)[0]?.exchanges[0]?.prompt).toBe("Review");
	});

	it("ignores catalog properties attached through live session-record reads", () => {
		const store = new SessionStore();
		const owner = store.mint({ spawn: "recipe-app" });
		const escaped = store.getByTeam(store.teamOf(owner)) as typeof owner & { codexCatalog?: unknown };
		escaped.codexCatalog = { version: 1, revision: 99, agents: [requestedAgent()] };

		expect(store.codexCatalog(owner)).toBeUndefined();
		expect(store.snapshot()[store.teamOf(owner)]).not.toHaveProperty("codexCatalog");
		expect("createCodexCatalogWriter" in store).toBe(false);
	});

	it("removes the nested catalog with its owning session", () => {
		const { store, catalogWriter } = storeWithCatalogWriter();
		const owner = store.mint({ spawn: "recipe-app" });
		catalogWriter.commit(owner, 0, [requestedAgent()]);

		expect(store.forget(store.teamOf(owner))).toBe(true);
		expect(store.codexCatalog(owner)).toBeUndefined();
	});

	it("removes the nested catalog when the owning session is swept", () => {
		let clock = 100;
		let catalogWriter: CodexCatalogWriter | undefined;
		const store = new SessionStore({
			now: () => clock,
			codexCatalogPersistence: {
				persistChecked: () => {},
				receiveWriter: (writer) => {
					catalogWriter = writer;
				},
			},
		});
		const owner = store.mint({ spawn: "recipe-app" });
		catalogWriter!.commit(owner, 0, [requestedAgent()]);
		clock = 1_000;

		expect(store.sweep(500)).toEqual([store.teamOf(owner)]);
		expect(store.codexCatalog(owner)).toBeUndefined();
	});
});
