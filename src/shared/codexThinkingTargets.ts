// Codex delegation: where a thread runs (as requested, and as resolved by the daemon), plus the
// SOLE owner of the targetId grammar (`host`, or `container:<project-slug>`).

import { z } from "zod";
import { OpaqueIdSchema } from "./codexThinkingIdentity.js";
import { isSlug } from "./session-id.js";

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

export const CodexExecutionTargetSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("host"),
			workdirHint: z.string().min(1).max(512),
		})
		.strict(),
	z
		.object({
			kind: z.literal("devcontainer"),
			project: z.string().refine(isSlug, "project must be a slug"),
			hostProjectPath: z.string().min(1).max(4096).refine(isAbsolutePath, "project path must be absolute"),
		})
		.strict(),
]);

export const CodexResolvedTargetSchema = z
	.object({
		kind: z.enum(["host", "devcontainer"]),
		targetId: OpaqueIdSchema,
		cwd: z.string().min(1).max(4096).refine(isAbsolutePath, "cwd must be absolute"),
	})
	.strict();

/** The SOLE owner of the targetId grammar: `host`, or `container:<project-slug>`. Everything that
 * builds or reads one goes through here, so a launcher cannot invent its own reading of the field. */
export const CODEX_HOST_TARGET_ID = "host";
const CODEX_CONTAINER_PREFIX = "container:";

export function codexContainerTargetId(project: string): string {
	return `${CODEX_CONTAINER_PREFIX}${project}`;
}

export function parseCodexTargetId(
	targetId: string,
): { kind: "host" } | { kind: "devcontainer"; project: string } | null {
	if (targetId === CODEX_HOST_TARGET_ID) return { kind: "host" };
	if (!targetId.startsWith(CODEX_CONTAINER_PREFIX)) return null;
	const project = targetId.slice(CODEX_CONTAINER_PREFIX.length);
	return isSlug(project) ? { kind: "devcontainer", project } : null;
}

export type CodexExecutionTarget = z.infer<typeof CodexExecutionTargetSchema>;
export type CodexResolvedTarget = z.infer<typeof CodexResolvedTargetSchema>;
