import { z } from "zod";
import { restoreAgentCatalog } from "./agent-record.js";
import { CopilotAgentIdSchema, CopilotOpaqueIdSchema } from "./copilotAgentIdentity.js";
import { CopilotPersistedAgentSchema } from "./copilotAgentRecord.js";
import { CopilotAgentStateSchema, CopilotTurnStateSchema } from "./copilotAgentState.js";

export const CopilotAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CopilotPersistedAgentSchema),
	})
	.strict();
export type CopilotAgentCatalog = z.infer<typeof CopilotAgentCatalogSchema>;

export function restoreCopilotAgentCatalog(raw: unknown): CopilotAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = CopilotPersistedAgentSchema.safeParse(candidate);
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = CopilotAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}

export const CopilotListAgentSchema = z
	.object({
		agentId: CopilotAgentIdSchema,
		agentState: CopilotAgentStateSchema,
		activeTurnId: CopilotOpaqueIdSchema.optional(),
		turns: z.array(z.object({ id: CopilotOpaqueIdSchema, state: CopilotTurnStateSchema }).strict()),
		operations: z.array(
			z
				.object({
					kind: z.enum(["start", "message", "stop"]),
					state: z.string(),
					prompt: z.string().optional(),
				})
				.strict(),
		),
	})
	.strict();
export const CopilotListAgentsResultSchema = z.object({ agents: z.array(CopilotListAgentSchema) }).strict();

export type CopilotListAgent = z.infer<typeof CopilotListAgentSchema>;
export type CopilotListAgentsResult = z.infer<typeof CopilotListAgentsResultSchema>;

export interface CopilotListAgentSource {
	agentId: string;
	agentState: z.infer<typeof CopilotAgentStateSchema>;
	activeTurnId?: string;
	turns: ReadonlyArray<{ id: string; state: z.infer<typeof CopilotTurnStateSchema> }>;
	operations: ReadonlyArray<{ kind: "start" | "message" | "stop"; state: string; prompt?: string }>;
}

export function projectCopilotListAgent(agent: CopilotListAgentSource): CopilotListAgent {
	// Public rows copy only explicitly exposed fields.
	return CopilotListAgentSchema.parse({
		agentId: agent.agentId,
		agentState: agent.agentState,
		...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
		turns: agent.turns.map((turn) => ({ id: turn.id, state: turn.state })),
		operations: agent.operations.map((operation) => ({
			kind: operation.kind,
			state: operation.state,
			...(operation.prompt ? { prompt: operation.prompt } : {}),
		})),
	});
}

export function projectCopilotListResult(agents: readonly CopilotListAgentSource[]): CopilotListAgentsResult {
	return CopilotListAgentsResultSchema.parse({ agents: agents.map(projectCopilotListAgent) });
}
