import {
	type CodexPersistedAgent,
	CodexPersistedAgentSchema,
	codexOperationFingerprint,
} from "../../shared/codex-agent.js";

////////////////////////////////
//  Constants

export const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
export const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

////////////////////////////////
//  Functions & Helpers

export function requestedAgent(agentId = AGENT_ID, operationId = OPERATION_ID): CodexPersistedAgent {
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
