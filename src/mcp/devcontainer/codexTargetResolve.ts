import {
	CODEX_HOST_TARGET_ID,
	type CodexExecutionTarget,
	type CodexResolvedTarget,
	CodexResolvedTargetSchema,
	codexContainerTargetId,
} from "../../shared/codex-thinking.js";

////////////////////////////////
//  Functions & Helpers

export function codexTargetIdFor(target: CodexExecutionTarget): string {
	return target.kind === "host" ? CODEX_HOST_TARGET_ID : codexContainerTargetId(target.project);
}

/**
 * A requested target resolved to the one a child actually runs under. The cwd rides the thread, so
 * it is the only per-agent part of this.
 *
 * A host session's hint is NOT a path. It may be a console-picked directory or a bare human label,
 * and `resolveHostWorkdir` is the one place that knows which is which. Passing the hint through as a
 * cwd made every host start fail its own schema and be refused as an unavailable target.
 */
export function resolveCodexTarget(
	target: CodexExecutionTarget,
	resolveHostCwd: (hint: string | undefined) => string,
): CodexResolvedTarget {
	return CodexResolvedTargetSchema.parse({
		kind: target.kind,
		targetId: codexTargetIdFor(target),
		cwd: target.kind === "host" ? resolveHostCwd(target.workdirHint) : `/workspace/${target.project}`,
	});
}
