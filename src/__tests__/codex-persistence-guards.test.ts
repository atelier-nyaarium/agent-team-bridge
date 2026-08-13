import { describe, expect, it } from "vitest";
import { CodexTransitionError } from "../gateway/codexAgentService.js";
import { CodexPersistedAgentSchema, codexOperationFingerprint } from "../shared/codex-thinking.js";
import { setup } from "./helpers/codex-persistence.js";
import { AGENT_ID, OPERATION_ID } from "./helpers/codex-thinking.js";

const OTHER_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const THIRD_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const DEVCONTAINER_TARGET = {
	kind: "devcontainer",
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
} as const;

describe("Codex checked delivery ordering guards", () => {
	it("serializes unresolved prompt delivery ahead of messages and stops", () => {
		const { request, service } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			target: DEVCONTAINER_TARGET,
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
			target: DEVCONTAINER_TARGET,
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
			target: DEVCONTAINER_TARGET,
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

	it("blocks follow-up delivery while an interrupt is pending", () => {
		const { request, service } = setup();
		service.beginStart(request, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			target: DEVCONTAINER_TARGET,
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
			target: DEVCONTAINER_TARGET,
			at: 20,
		});

		expect(() =>
			service.beginStart(request, {
				agentId: AGENT_ID,
				operationId: OPERATION_ID,
				prompt: "Change the project",
				target: DEVCONTAINER_TARGET,
				at: 21,
			}),
		).toThrowError(CodexTransitionError);
	});
});
