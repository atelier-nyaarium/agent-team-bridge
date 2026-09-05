import { z } from "zod";
import { agentActivityIssues } from "./agent-record.js";
import {
	boundedUtf8,
	COPILOT_ACTIVITY_MAX_BYTES,
	COPILOT_ACTIVITY_MAX_ITEMS,
	CopilotOpaqueIdSchema,
} from "./copilotAgentIdentity.js";

export const CopilotActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			text: boundedUtf8(COPILOT_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z.object({ kind: z.literal("truncated"), omitted: z.number().int().positive() }).strict(),
]);

export const CopilotStoredActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			itemId: CopilotOpaqueIdSchema,
			text: boundedUtf8(COPILOT_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z.object({ kind: z.literal("truncated"), omitted: z.number().int().positive() }).strict(),
]);

export const CopilotActivitiesSchema = z
	.array(CopilotActivitySchema)
	.max(COPILOT_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, COPILOT_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export const CopilotStoredActivitiesSchema = z
	.array(CopilotStoredActivitySchema)
	.max(COPILOT_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, COPILOT_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export type CopilotStoredActivity = z.infer<typeof CopilotStoredActivitySchema>;
