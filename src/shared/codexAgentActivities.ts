// Codex delegation: the narration items a turn accumulates while it runs, in their caller-visible
// and durable-storage shapes, plus the array-level truncation-marker invariant both share.

import { z } from "zod";
import { agentActivityIssues } from "./agent-record.js";
import {
	boundedUtf8,
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ACTIVITY_MAX_ITEMS,
	OpaqueIdSchema,
} from "./codexAgentIdentity.js";

export const CodexActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			text: boundedUtf8(CODEX_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("truncated"),
			omitted: z.number().int().positive(),
		})
		.strict(),
]);

export const CodexStoredActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			itemId: OpaqueIdSchema,
			text: boundedUtf8(CODEX_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("truncated"),
			omitted: z.number().int().positive(),
		})
		.strict(),
]);

export const CodexActivitiesSchema = z
	.array(CodexActivitySchema)
	.max(CODEX_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, CODEX_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export const CodexStoredActivitiesSchema = z
	.array(CodexStoredActivitySchema)
	.max(CODEX_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, CODEX_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export type CodexStoredActivity = z.infer<typeof CodexStoredActivitySchema>;
