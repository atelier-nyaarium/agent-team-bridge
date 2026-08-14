import {
	AGENT_HOST_TARGET_ID,
	type AgentExecutionTarget,
	type AgentResolvedTarget,
	AgentResolvedTargetSchema,
	agentContainerTargetId,
} from "../../shared/agent-execution-target.js";

////////////////////////////////
//  Functions & Helpers

export function agentTargetIdFor(target: AgentExecutionTarget): string {
	return target.kind === "host" ? AGENT_HOST_TARGET_ID : agentContainerTargetId(target.project);
}

/** A host hint is NOT a path: it may be a picked directory or a bare label, and `resolveHostWorkdir`
 * is the one place that knows which. */
export function resolveAgentTarget(
	target: AgentExecutionTarget,
	resolveHostCwd: (hint: string | undefined) => string,
): AgentResolvedTarget {
	return AgentResolvedTargetSchema.parse({
		kind: target.kind,
		targetId: agentTargetIdFor(target),
		cwd: target.kind === "host" ? resolveHostCwd(target.workdirHint) : `/workspace/${target.project}`,
	});
}
