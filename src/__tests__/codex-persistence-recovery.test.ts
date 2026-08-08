import { describe, expect, it } from "vitest";
import { CodexAgentService, CodexTransitionError } from "../gateway/codexAgentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation } from "../gateway/websocket.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";
import { setup } from "./helpers/codex-persistence.js";
import { AGENT_ID, OPERATION_ID } from "./helpers/codex-thinking.js";

describe("Codex checked persistence failure recovery", () => {
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
});
