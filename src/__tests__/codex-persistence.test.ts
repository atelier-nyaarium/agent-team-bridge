import { describe, expect, it } from "vitest";
import { CodexAgentService, CodexTransitionError } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/websocket.js";
import {
	CodexAgentCatalogSchema,
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	codexOperationFingerprint,
	restoreCodexAgentCatalog,
} from "../shared/codex-thinking.js";
import { DurableStoreInstalledError } from "../shared/durable-store.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const OTHER_AGENT_ID = "codex_ffffffffffffffffffffffffffffffff";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const THIRD_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174002";

function requestedAgent(agentId = AGENT_ID, operationId = OPERATION_ID): CodexPersistedAgent {
	return CodexPersistedAgentSchema.parse({
		version: 1,
		agentId,
		agentState: "creating",
		requestedTarget: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		exchanges: [
			{
				exchangeId: operationId,
				operationId,
				kind: "start",
				prompt: "Review",
				status: "requested",
				createdAt: 10,
			},
		],
		turns: [],
		operations: [
			{
				operationId,
				kind: "start",
				fingerprint: codexOperationFingerprint("start", agentId, "Review"),
				state: "requested",
				preDispatch: { agentState: "creating" },
				createdAt: 10,
				updatedAt: 10,
			},
		],
		createdAt: 10,
		updatedAt: 10,
	});
}

function setup(opts: { failSave?: (saveNumber: number) => boolean; installedFailure?: boolean } = {}) {
	let sessionStore!: SessionStore;
	let catalogWriter: CodexCatalogWriter | undefined;
	let saves = 0;
	const savedSnapshots: unknown[] = [];
	const persistChecked = () => {
		saves++;
		if (opts.failSave?.(saves)) {
			const cause = new Error("disk unavailable");
			throw opts.installedFailure ? new DurableStoreInstalledError(cause) : cause;
		}
		savedSnapshots.push(sessionStore.snapshot());
	};
	sessionStore = new SessionStore({
		codexCatalogPersistence: {
			persistChecked,
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
	const offlineCatalog = new Map([["recipe-app", "/trusted/recipe-app"]]);
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({ auth, sessionStore, offlineCatalog, catalogWriter });
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const request = new Request("http://gateway/codex", { headers: { "x-session-token": token } });
	return {
		request,
		owner,
		service,
		sessionStore,
		offlineCatalog,
		catalogWriter,
		savedSnapshots,
		saves: () => saves,
	};
}

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

		expect(store.sweep(500)).toBe(true);
		expect(store.codexCatalog(owner)).toBeUndefined();
	});
});

describe("Codex checked recovery transitions", () => {
	it("durably records the full start intent before native dispatch", () => {
		const { request, owner, service, sessionStore, offlineCatalog, savedSnapshots } = setup();
		const result = service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review every authorization boundary",
			at: 20,
		});

		expect(result.disposition).toBe("committed");
		expect(result.agent.agentId).toBe(AGENT_ID);
		expect(result.operation).toMatchObject({
			operationId: OPERATION_ID,
			state: "requested",
			preDispatch: { agentState: "creating" },
		});
		expect(result.agent.exchanges[0]?.prompt).toBe("Review every authorization boundary");
		expect(savedSnapshots).toHaveLength(1);
		expect(sessionStore.codexCatalog(owner)?.revision).toBe(1);

		offlineCatalog.clear();
		const retry = service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review every authorization boundary",
			at: 21,
		});
		expect(retry.disposition).toBe("indeterminate");
		expect(savedSnapshots).toHaveLength(1);
	});

	it("commits native IDs and state only after a checked acceptance save", () => {
		const { request, service, saves } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});

		const result = service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});

		expect(result.disposition).toBe("committed");
		expect(result.agent).toMatchObject({
			agentState: "working",
			threadId: "thread-1",
			activeTurnId: "turn-1",
			fence: { daemonInstanceId: "daemon-1", generation: 1, lastEventId: 2 },
		});
		expect(result.operation).toMatchObject({ state: "accepted", turnId: "turn-1" });
		expect(saves()).toBe(2);
		expect(
			service.acceptDelivery(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
				threadId: "thread-1",
				turnId: "turn-1",
				delivery: "started",
				fence: {
					lastEventId: 2,
					generation: 1,
					targetId: "container:recipe-app",
					daemonInstanceId: "daemon-1",
				},
				at: 22,
			}).disposition,
		).toBe("replayed");
		expect(() =>
			service.acceptDelivery(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
				threadId: "thread-changed",
				turnId: "turn-1",
				delivery: "started",
				fence: {
					daemonInstanceId: "daemon-1",
					targetId: "container:recipe-app",
					generation: 1,
					lastEventId: 2,
				},
				at: 22,
			}),
		).toThrowError(CodexTransitionError);
	});

	it("correlates daemon receipts without a Claude HTTP request", () => {
		const { request, owner, service, sessionStore } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});

		const accepted = service.acceptDeliveryFromDaemon({
			ownerKey: sessionStore.teamOf(owner),
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});

		expect(accepted.disposition).toBe("committed");
		expect(accepted.owner.spawn).toBe("recipe-app");
	});

	it("uses the echoed owner correlation when internal IDs collide", () => {
		const { request, owner, service, sessionStore, catalogWriter } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		const otherOwner = sessionStore.mint({ spawn: "other-project" });
		catalogWriter.commit(otherOwner, 0, [requestedAgent()]);

		const accepted = service.acceptDeliveryFromDaemon({
			ownerKey: sessionStore.teamOf(owner),
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: {
				daemonInstanceId: "daemon-1",
				targetId: "container:recipe-app",
				generation: 1,
				lastEventId: 2,
			},
			at: 21,
		});

		expect(accepted.owner).toBe(owner);
		expect(sessionStore.codexCatalog(otherOwner)?.agents[0]?.agentState).toBe("creating");
	});

	it("serializes unresolved prompt delivery ahead of messages and stops", () => {
		const { request, service } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});
		const pending = service.beginMessage(request, {
			agentId: AGENT_ID,
			operationId: OTHER_OPERATION_ID,
			prompt: "Continue",
			at: 22,
		});

		expect(pending.operation.preDispatch.fence).toEqual(pending.agent.fence);
		expect(
			service.acceptDelivery(request, {
				agentId: AGENT_ID,
				operationId: OTHER_OPERATION_ID,
				resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
				threadId: "thread-1",
				turnId: "turn-2",
				delivery: "started",
				fence: {
					daemonInstanceId: "daemon-1",
					targetId: "container:recipe-app",
					generation: 1,
					lastEventId: 3,
				},
				at: 23,
			}).disposition,
		).toBe("indeterminate");
		expect(() =>
			service.beginMessage(request, {
				agentId: AGENT_ID,
				operationId: THIRD_OPERATION_ID,
				prompt: "Also inspect tests",
				at: 23,
			}),
		).toThrowError(CodexTransitionError);
		expect(() =>
			service.beginStop(request, { agentId: AGENT_ID, operationId: THIRD_OPERATION_ID, at: 23 }),
		).toThrowError(CodexTransitionError);
	});

	it("keeps indeterminate operations non-dispatchable on exact retry", () => {
		const { request, owner, service, sessionStore, catalogWriter } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});
		const catalog = sessionStore.codexCatalog(owner)!;
		const current = catalog.agents[0]!;
		const indeterminate = CodexPersistedAgentSchema.parse({
			...current,
			exchanges: [
				...current.exchanges,
				{
					exchangeId: OTHER_OPERATION_ID,
					operationId: OTHER_OPERATION_ID,
					kind: "message",
					prompt: "Continue",
					status: "indeterminate",
					createdAt: 22,
				},
			],
			operations: [
				...current.operations,
				{
					operationId: OTHER_OPERATION_ID,
					kind: "message",
					fingerprint: codexOperationFingerprint("message", AGENT_ID, "Continue"),
					state: "indeterminate",
					expectedTurnId: "turn-1",
					preDispatch: {
						agentState: "working",
						threadId: "thread-1",
						turnId: "turn-1",
						fence: current.fence,
					},
					createdAt: 22,
					updatedAt: 22,
				},
			],
			updatedAt: 22,
		});
		catalogWriter.commit(owner, catalog.revision, [indeterminate]);

		expect(
			service.beginMessage(request, {
				agentId: AGENT_ID,
				operationId: OTHER_OPERATION_ID,
				prompt: "Continue",
				at: 23,
			}).disposition,
		).toBe("indeterminate");
	});

	it("does not regress a recovery fence when a stale delivery receipt arrives", () => {
		const { request, owner, service, sessionStore, catalogWriter } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});
		service.beginMessage(request, {
			agentId: AGENT_ID,
			operationId: OTHER_OPERATION_ID,
			prompt: "Continue",
			at: 22,
		});
		const catalog = sessionStore.codexCatalog(owner)!;
		const advanced = CodexPersistedAgentSchema.parse({
			...catalog.agents[0]!,
			fence: {
				daemonInstanceId: "daemon-1",
				targetId: "container:recipe-app",
				generation: 1,
				lastEventId: 4,
			},
			updatedAt: 23,
		});
		catalogWriter.commit(owner, catalog.revision, [advanced]);

		const stale = service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OTHER_OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "steered",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 3 },
			at: 24,
		});

		expect(stale.disposition).toBe("indeterminate");
		// The refusal SETTLES the delivery and puts the agent into recovery. Leaving it requested would
		// block every later message and stop for this agent with nothing able to clear it.
		expect(sessionStore.codexCatalog(owner)?.agents[0]).toMatchObject({
			fence: { lastEventId: 4 },
			agentState: "recovering",
			operations: [{ state: "accepted" }, { state: "indeterminate" }],
			exchanges: [{ status: "accepted" }, { status: "indeterminate" }],
		});
	});

	it("returns indeterminate and retains the durable intent when acceptance persistence fails", () => {
		const { request, owner, service, sessionStore, saves } = setup({ failSave: (save) => save === 2 });
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});

		const result = service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-orphaned",
			turnId: "turn-orphaned",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});

		expect(result.disposition).toBe("indeterminate");
		expect(sessionStore.codexCatalog(owner)).toMatchObject({
			revision: 1,
			agents: [{ agentState: "creating", operations: [{ state: "requested" }] }],
		});
		const retry = service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 22,
		});
		expect(retry.disposition).toBe("indeterminate");
		expect(retry.operation.state).toBe("requested");
		expect(saves()).toBe(2);

		let restoredWriter: CodexCatalogWriter | undefined;
		const restoredStore = new SessionStore({
			codexCatalogPersistence: {
				persistChecked: () => {},
				receiveWriter: (writer) => {
					restoredWriter = writer;
				},
			},
		});
		restoredStore.restore(sessionStore.snapshot());
		const restoredOwner = restoredStore.getByTeam(sessionStore.teamOf(owner))!;
		const restoredAuth = createSessionAuthority({
			sessionStore: restoredStore,
			registry: new Map(),
			resolveLive: resolveLiveIncarnation,
			localDomainId: () => "alice",
			localGatewayId: "sakura",
		});
		const restoredService = new CodexAgentService({
			auth: restoredAuth,
			sessionStore: restoredStore,
			offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
			catalogWriter: restoredWriter!,
		});
		const restoredRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": restoredOwner.bindToken! },
		});
		expect(
			restoredService.beginStart(restoredRequest, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				at: 23,
			}).disposition,
		).toBe("indeterminate");
	});

	it("re-checkpoints an installed but unconfirmed acceptance before replay", () => {
		const { request, owner, service, sessionStore, saves } = setup({
			failSave: (save) => save === 2,
			installedFailure: true,
		});
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		const receipt = {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: {
				kind: "devcontainer" as const,
				targetId: "container:recipe-app",
				cwd: "/workspace",
			},
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started" as const,
			fence: {
				daemonInstanceId: "daemon-1",
				targetId: "container:recipe-app",
				generation: 1,
				lastEventId: 2,
			},
			at: 21,
		};

		expect(service.acceptDelivery(request, receipt).disposition).toBe("indeterminate");
		expect(sessionStore.codexCatalog(owner)).toMatchObject({
			revision: 2,
			agents: [{ operations: [{ state: "accepted" }] }],
		});
		expect(service.acceptDelivery(request, { ...receipt, at: 22 }).disposition).toBe("replayed");
		expect(saves()).toBe(3);

		let restoredWriter: CodexCatalogWriter | undefined;
		let restartCheckpoints = 0;
		const restoredStore = new SessionStore({
			codexCatalogPersistence: {
				persistChecked: () => {
					restartCheckpoints++;
				},
				receiveWriter: (writer) => {
					restoredWriter = writer;
				},
			},
		});
		restoredStore.restore(sessionStore.snapshot());
		const restoredOwner = restoredStore.getByTeam(sessionStore.teamOf(owner))!;
		const restoredService = new CodexAgentService({
			auth: createSessionAuthority({
				sessionStore: restoredStore,
				registry: new Map(),
				resolveLive: resolveLiveIncarnation,
				localDomainId: () => "alice",
				localGatewayId: "sakura",
			}),
			sessionStore: restoredStore,
			offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
			catalogWriter: restoredWriter!,
		});
		const restoredRequest = new Request("http://gateway/codex", {
			headers: { "x-session-token": restoredOwner.bindToken! },
		});

		expect(
			restoredService.beginStart(restoredRequest, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				at: 23,
			}).disposition,
		).toBe("replayed");
		expect(restartCheckpoints).toBe(1);
	});

	it("keeps acceptance indeterminate while its checkpoint remains unconfirmed", () => {
		const { request, service } = setup({
			failSave: (save) => save >= 2,
			installedFailure: true,
		});
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		const receipt = {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: {
				kind: "devcontainer" as const,
				targetId: "container:recipe-app",
				cwd: "/workspace",
			},
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started" as const,
			fence: {
				daemonInstanceId: "daemon-1",
				targetId: "container:recipe-app",
				generation: 1,
				lastEventId: 2,
			},
			at: 21,
		};

		expect(service.acceptDelivery(request, receipt).disposition).toBe("indeterminate");
		expect(service.acceptDelivery(request, { ...receipt, at: 22 }).disposition).toBe("indeterminate");
	});

	it("rolls back a start intent when its pre-dispatch checked save fails", () => {
		const { request, owner, service, sessionStore } = setup({ failSave: (save) => save === 1 });

		expect(() =>
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				at: 20,
			}),
		).toThrowError(CodexTransitionError);
		expect(sessionStore.codexCatalog(owner)).toBeUndefined();
	});

	it("keeps an installed but unconfirmed start intent non-dispatchable", () => {
		const { request, owner, service, sessionStore } = setup({
			failSave: (save) => save === 1,
			installedFailure: true,
		});

		expect(() =>
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				at: 20,
			}),
		).toThrowError(CodexTransitionError);
		expect(sessionStore.codexCatalog(owner)).toMatchObject({
			revision: 1,
			agents: [{ operations: [{ state: "requested" }] }],
		});
		expect(
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Review",
				at: 21,
			}).disposition,
		).toBe("indeterminate");
	});

	it("blocks follow-up delivery while an interrupt is pending", () => {
		const { request, service } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});
		service.acceptDelivery(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" },
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
			fence: { daemonInstanceId: "daemon-1", targetId: "container:recipe-app", generation: 1, lastEventId: 2 },
			at: 21,
		});
		service.beginStop(request, { agentId: AGENT_ID, operationId: OTHER_OPERATION_ID, at: 22 });

		expect(() =>
			service.beginMessage(request, {
				agentId: AGENT_ID,
				operationId: THIRD_OPERATION_ID,
				prompt: "Continue",
				at: 23,
			}),
		).toThrowError(CodexTransitionError);
	});

	it("rejects reuse of an owner-scoped operation ID with different input", () => {
		const { request, service } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			at: 20,
		});

		expect(() =>
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Change the project",
				at: 21,
			}),
		).toThrowError(CodexTransitionError);
	});
});
