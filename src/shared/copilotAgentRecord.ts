import { z } from "zod";
import { agentFingerprintVerdict, agentTurnHistoryIssues } from "./agent-record.js";
import { CopilotStoredActivitiesSchema } from "./copilotAgentActivities.js";
import {
	CopilotAgentIdSchema,
	CopilotErrorTextSchema,
	CopilotOpaqueIdSchema,
	CopilotOperationIdSchema,
	CopilotPromptSchema,
	copilotOperationIdentity,
} from "./copilotAgentIdentity.js";
import { CopilotAgentStateSchema } from "./copilotAgentState.js";
import { CopilotExecutionTargetSchema, CopilotResolvedTargetSchema } from "./copilotAgentTargets.js";

export const CopilotStoredTurnSchema = z.discriminatedUnion("state", [
	z
		.object({
			id: CopilotOpaqueIdSchema,
			state: z.literal("inProgress"),
			activities: CopilotStoredActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: CopilotOpaqueIdSchema,
			state: z.literal("completed"),
			activities: CopilotStoredActivitiesSchema,
			finalResponse: z.string(),
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: CopilotOpaqueIdSchema,
			state: z.literal("failed"),
			activities: CopilotStoredActivitiesSchema,
			error: CopilotErrorTextSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: CopilotOpaqueIdSchema,
			state: z.literal("interrupted"),
			activities: CopilotStoredActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
]);

export const CopilotStoredOperationSchema = z
	.object({
		operationId: CopilotOperationIdSchema,
		kind: z.enum(["start", "message", "stop"]),
		prompt: CopilotPromptSchema.optional(),
		/** Optional for legacy records. Required to recheck start fingerprints. */
		model: z.string().min(1).max(128).optional(),
		fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		state: z.enum(["requested", "accepted", "indeterminate"]),
		turnId: CopilotOpaqueIdSchema.optional(),
		sessionId: CopilotOpaqueIdSchema.optional(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.updatedAt < value.createdAt)
			ctx.addIssue({ code: "custom", message: "operation update predates creation" });
		if (value.kind !== "start" && value.model !== undefined)
			ctx.addIssue({ code: "custom", message: "only a start operation carries a model" });
		if (
			(value.kind === "start" || value.kind === "message") &&
			value.state === "accepted" &&
			(!value.turnId || !value.sessionId)
		) {
			ctx.addIssue({ code: "custom", message: "accepted prompt requires session and turn" });
		}
	});

export const CopilotReconciliationFenceSchema = z
	.object({
		daemonInstanceId: CopilotOpaqueIdSchema,
		targetId: CopilotOpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		lastEventId: z.number().int().nonnegative(),
	})
	.strict();

export const CopilotPersistedAgentSchema = z
	.object({
		version: z.literal(1),
		agentId: CopilotAgentIdSchema,
		agentState: CopilotAgentStateSchema,
		requestedTarget: CopilotExecutionTargetSchema,
		resolvedTarget: CopilotResolvedTargetSchema.optional(),
		sessionId: CopilotOpaqueIdSchema.optional(),
		activeTurnId: CopilotOpaqueIdSchema.optional(),
		operations: z.array(CopilotStoredOperationSchema),
		turns: z.array(CopilotStoredTurnSchema),
		fence: CopilotReconciliationFenceSchema.optional(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const message of agentTurnHistoryIssues(value)) ctx.addIssue({ code: "custom", message });
		if (!!value.sessionId !== !!value.resolvedTarget)
			ctx.addIssue({ code: "custom", message: "session and target must appear together" });
		if (value.activeTurnId && !value.sessionId)
			ctx.addIssue({ code: "custom", message: "active turn requires a session" });
		if (value.agentState === "creating" && (value.sessionId || value.turns.length > 0 || value.activeTurnId)) {
			ctx.addIssue({ code: "custom", message: "creating agent cannot contain native state" });
		}
		if (new Set(value.operations.map((operation) => operation.operationId)).size !== value.operations.length) {
			ctx.addIssue({ code: "custom", message: "stored operation IDs must be unique" });
		}
		for (const operation of value.operations) {
			if (operation.createdAt < value.createdAt || operation.updatedAt > value.updatedAt) {
				ctx.addIssue({ code: "custom", message: "stored operation timestamp is outside its agent lifetime" });
			}
			// Unverifiable legacy fingerprints are tolerated. Mismatches are rejected.
			if (
				agentFingerprintVerdict(
					operation.fingerprint,
					copilotOperationIdentity({
						kind: operation.kind,
						agentId: value.agentId,
						prompt: operation.prompt,
						model: operation.model,
					}),
				) === "mismatch"
			) {
				ctx.addIssue({ code: "custom", message: "stored operation fingerprint does not match" });
			}
		}
	});

export type CopilotPersistedAgent = z.infer<typeof CopilotPersistedAgentSchema>;
export type CopilotStoredOperation = z.infer<typeof CopilotStoredOperationSchema>;
export type CopilotStoredTurn = z.infer<typeof CopilotStoredTurnSchema>;
export type CopilotReconciliationFence = z.infer<typeof CopilotReconciliationFenceSchema>;
