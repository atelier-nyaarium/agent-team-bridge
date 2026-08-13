// Where a delegated agent thread runs, neutrally named: the requested target, the daemon-resolved
// target, the owner key, and the SOLE owner of the targetId grammar (`host`, or
// `container:<project-slug>`). Backend-agnostic on purpose; the per-backend schema families alias
// these rather than re-declaring them, so the two backends cannot drift on where a thread may run.

import { z } from "zod";
import { isComposite, isSlug, parseSessionName } from "./session-id.js";

////////////////////////////////
//  Schemas

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

export const AgentExecutionTargetSchema = z.discriminatedUnion("kind", [
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

export const AgentResolvedTargetSchema = z
	.object({
		kind: z.enum(["host", "devcontainer"]),
		targetId: z.string().min(1).max(512),
		cwd: z.string().min(1).max(4096).refine(isAbsolutePath, "cwd must be absolute"),
	})
	.strict();

export const AgentOwnerKeySchema = z
	.string()
	.min(3)
	.max(129)
	.refine((value) => {
		if (!isComposite(value)) return false;
		const { project, session } = parseSessionName(value);
		return isSlug(project) && isSlug(session);
	}, "owner key must contain two canonical slugs");

////////////////////////////////
//  Functions & Helpers

/** The SOLE owner of the targetId grammar. Everything that builds or reads one goes through here,
 * so a launcher cannot invent its own reading of the field. */
export const AGENT_HOST_TARGET_ID = "host";
const AGENT_CONTAINER_PREFIX = "container:";

export function agentContainerTargetId(project: string): string {
	return `${AGENT_CONTAINER_PREFIX}${project}`;
}

export function parseAgentTargetId(
	targetId: string,
): { kind: "host" } | { kind: "devcontainer"; project: string } | null {
	if (targetId === AGENT_HOST_TARGET_ID) return { kind: "host" };
	if (!targetId.startsWith(AGENT_CONTAINER_PREFIX)) return null;
	const project = targetId.slice(AGENT_CONTAINER_PREFIX.length);
	return isSlug(project) ? { kind: "devcontainer", project } : null;
}

export type AgentExecutionTarget = z.infer<typeof AgentExecutionTargetSchema>;
export type AgentResolvedTarget = z.infer<typeof AgentResolvedTargetSchema>;
