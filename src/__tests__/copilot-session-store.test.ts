import { describe, expect, it } from "vitest";
import { CopilotPersistedAgentSchema, copilotOperationFingerprint } from "../shared/copilot-thinking.js";
import { type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

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
		const agent = CopilotPersistedAgentSchema.parse({
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

		expect(writer).toBeDefined();
		writer!.commit(owner, 0, [agent]);

		const restored = new SessionStore();
		restored.restore(store.snapshot());
		const restoredOwner = restored.getByTeam(store.teamOf(owner));
		expect(restoredOwner).toBeDefined();
		expect(restored.listCopilotAgents(restoredOwner!)).toEqual([agent]);
	});
});
