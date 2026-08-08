// Codex delegation: the narration items a turn accumulates while it runs, in their caller-visible
// and durable-storage shapes, plus the array-level truncation-marker invariant both share.

import { z } from "zod";
import {
	boundedUtf8,
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ACTIVITY_MAX_ITEMS,
	OpaqueIdSchema,
} from "./codexThinkingIdentity.js";

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
		const commentaryCount = activities.filter((activity) => activity.kind === "commentary").length;
		const markerIndexes = activities.flatMap((activity, index) => (activity.kind === "truncated" ? [index] : []));
		if (commentaryCount > CODEX_ACTIVITY_MAX_ITEMS) {
			ctx.addIssue({ code: "custom", message: "too many commentary activities" });
		}
		if (markerIndexes.length > 1 || (markerIndexes.length === 1 && markerIndexes[0] !== activities.length - 1)) {
			ctx.addIssue({ code: "custom", message: "the truncation marker must appear once at the end" });
		}
		if (markerIndexes.length === 1 && commentaryCount !== CODEX_ACTIVITY_MAX_ITEMS) {
			ctx.addIssue({ code: "custom", message: "truncation requires a full retained activity window" });
		}
	});

export const CodexStoredActivitiesSchema = z
	.array(CodexStoredActivitySchema)
	.max(CODEX_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		const commentary = activities.filter((activity) => activity.kind === "commentary");
		const markerIndexes = activities.flatMap((activity, index) => (activity.kind === "truncated" ? [index] : []));
		if (commentary.length > CODEX_ACTIVITY_MAX_ITEMS) {
			ctx.addIssue({ code: "custom", message: "too many commentary activities" });
		}
		if (new Set(commentary.map((activity) => activity.itemId)).size !== commentary.length) {
			ctx.addIssue({ code: "custom", message: "stored activity item IDs must be unique" });
		}
		if (markerIndexes.length > 1 || (markerIndexes.length === 1 && markerIndexes[0] !== activities.length - 1)) {
			ctx.addIssue({ code: "custom", message: "the truncation marker must appear once at the end" });
		}
		if (markerIndexes.length === 1 && commentary.length !== CODEX_ACTIVITY_MAX_ITEMS) {
			ctx.addIssue({ code: "custom", message: "truncation requires a full retained activity window" });
		}
	});

export type CodexStoredActivity = z.infer<typeof CodexStoredActivitySchema>;
