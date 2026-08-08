import { describe, expect, it } from "vitest";
import { CodexTransitionError } from "../gateway/codexAgentService.js";
import { setup } from "./helpers/codex-persistence.js";
import { AGENT_ID, OPERATION_ID, requestedAgent } from "./helpers/codex-thinking.js";

describe("Codex checked start and delivery correlation", () => {
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
});
