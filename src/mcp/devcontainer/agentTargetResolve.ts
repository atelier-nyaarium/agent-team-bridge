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

/**
 * A requested target resolved to the one a child actually runs under. The cwd rides the thread, so
 * it is the only per-agent part of this.
 *
 * A host session's hint is NOT a path. It may be a console-picked directory or a bare human label,
 * and `resolveHostWorkdir` is the one place that knows which is which. Passing the hint through as a
 * cwd made every host start fail its own schema and be refused as an unavailable target.
 */
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
