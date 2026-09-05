// Copilot delegation: the owner-scoped catalog of persisted agents, restoring a catalog from
// durable storage, and the public list projection of one agent's history.

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

/**
 * What a producer must supply to be listed, which is deliberately NARROWER than any record it holds.
 *
 * Two producers feed this list and they name their history differently: the gateway's persisted
 * agent calls it `operations`, the session's own runtime calls it `exchanges` and carries the richer
 * Codex shape beside it. Both used to map to the public shape by hand, in their own file, against
 * a `.parse(unknown)` seam the compiler could not see through - so one of them silently stopped
 * matching and `copilotListAgents` threw on every non-empty list, which is what makes a spawned
 * agent's id unrecoverable. Naming the input here is what makes a mismatch a compile error.
 */
export interface CopilotListAgentSource {
	agentId: string;
	agentState: z.infer<typeof CopilotAgentStateSchema>;
	activeTurnId?: string;
	turns: ReadonlyArray<{ id: string; state: z.infer<typeof CopilotTurnStateSchema> }>;
	operations: ReadonlyArray<{ kind: "start" | "message" | "stop"; state: string; prompt?: string }>;
}

/** Builds the caller-visible row by explicitly copying only public fields. Sole owner of that set. */
export function projectCopilotListAgent(agent: CopilotListAgentSource): CopilotListAgent {
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
