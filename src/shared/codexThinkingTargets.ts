// Codex delegation: the Codex-named surface over the neutral execution-target module. Aliases, not
// re-declarations, so the two backends cannot drift on where a thread may run.

export type {
	AgentExecutionTarget as CodexExecutionTarget,
	AgentResolvedTarget as CodexResolvedTarget,
} from "./agent-execution-target.js";
export {
	AGENT_HOST_TARGET_ID as CODEX_HOST_TARGET_ID,
	AgentExecutionTargetSchema as CodexExecutionTargetSchema,
	AgentResolvedTargetSchema as CodexResolvedTargetSchema,
	agentContainerTargetId as codexContainerTargetId,
	parseAgentTargetId as parseCodexTargetId,
} from "./agent-execution-target.js";
