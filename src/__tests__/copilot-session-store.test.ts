import { describe, expect, it } from "vitest";
import {
	CopilotPersistedAgentSchema,
	copilotOperationFingerprint,
	restoreCopilotAgentCatalog,
} from "../shared/copilot-agent.js";
import { type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

function requestedAgent() {
	return CopilotPersistedAgentSchema.parse({
		version: 1,
		agentId: AGENT_ID,
		agentState: "creating",
		requestedTarget: { kind: "host", workdirHint: "Work" },
		operations: [
			{
				operationId: OPERATION_ID,
				kind: "start",
				prompt: "Review",
				fingerprint: copilotOperationFingerprint("start", AGENT_ID, "Review\nauto"),
				state: "requested",
				createdAt: 10,
				updatedAt: 10,
			},
		],
		turns: [],
		createdAt: 10,
		updatedAt: 10,
	});
}

function agentWithActivities(activities: unknown[]) {
	return {
		...requestedAgent(),
		agentState: "idle",
		resolvedTarget: { kind: "host", targetId: "host", cwd: "/home/agent" },
		sessionId: "session-1",
		turns: [{ id: "turn-1", state: "completed", activities, finalResponse: "Done", updatedAt: 12 }],
		updatedAt: 12,
	};
}

describe("Copilot session persistence", () => {
	it("round-trips the session-owned agent catalog", () => {
		let writer: CopilotCatalogWriter | undefined;
		const store = new SessionStore({
			copilotCatalogPersistence: {
				persistChecked: () => {},
				receiveWriter: (received) => {
					writer = received;
				},
			},
		});
		const owner = store.mint({ spawn: "host", sessionLabel: "Work" });
		const agent = requestedAgent();

		expect(writer).toBeDefined();
		writer!.commit(owner, 0, [agent]);

		const restored = new SessionStore();
		restored.restore(store.snapshot());
		const restoredOwner = restored.getByTeam(store.teamOf(owner));
		expect(restoredOwner).toBeDefined();
		expect(restored.listCopilotAgents(restoredOwner!)).toEqual([agent]);
	});

	it("rejects duplicate stored activity item ids", () => {
		const result = CopilotPersistedAgentSchema.safeParse(
			agentWithActivities([
				{ kind: "commentary", itemId: "item-1", text: "First" },
				{ kind: "commentary", itemId: "item-1", text: "Replay" },
			]),
		);

		expect(result.success).toBe(false);
	});

	it("rejects a truncation marker that is not last", () => {
		const result = CopilotPersistedAgentSchema.safeParse(
			agentWithActivities([
				{ kind: "truncated", omitted: 1 },
				{ kind: "commentary", itemId: "item-1", text: "Later" },
			]),
		);

		expect(result.success).toBe(false);
	});

	it("drops a damaged agent while restoring healthy siblings", () => {
		const healthy = requestedAgent();

		expect(
			restoreCopilotAgentCatalog({
				version: 1,
				revision: 7,
				agents: [healthy, { broken: true }],
			}),
		).toEqual({ version: 1, revision: 7, agents: [healthy] });
		expect(restoreCopilotAgentCatalog({ version: 1, revision: 7, agents: "broken" })).toBeUndefined();
	});
});
