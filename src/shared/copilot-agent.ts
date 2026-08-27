import { z } from "zod";
import { COPILOT_BACKEND } from "./agent-backend.js";
import {
	AgentExecutionTargetSchema,
	AgentOwnerKeySchema,
	AgentResolvedTargetSchema,
} from "./agent-execution-target.js";
import {
	AGENT_ACTIVITY_MAX_BYTES,
	AGENT_ACTIVITY_MAX_ITEMS,
	AGENT_ERROR_MAX_BYTES,
	AGENT_PROMPT_MAX_BYTES,
	type AgentOperationIdentity,
	agentActivityIssues,
	agentFingerprintVerdict,
	agentIdForOperation,
	agentOperationFingerprint,
	agentTurnHistoryIssues,
	boundedUtf8,
	restoreAgentCatalog,
	sanitizeAgentErrorText,
} from "./agent-record.js";

////////////////////////////////
//  Bounds

export const COPILOT_PROMPT_MAX_BYTES = AGENT_PROMPT_MAX_BYTES;
export const COPILOT_ACTIVITY_MAX_BYTES = AGENT_ACTIVITY_MAX_BYTES;
export const COPILOT_ACTIVITY_MAX_ITEMS = AGENT_ACTIVITY_MAX_ITEMS;
export const COPILOT_ERROR_MAX_BYTES = AGENT_ERROR_MAX_BYTES;
export const COPILOT_WAIT_BUDGET_MS = COPILOT_BACKEND.waitBudgetMs;
export const COPILOT_DEFAULT_MODEL = "gpt-5.6-luna";
export const COPILOT_AGENT_ID_RE = /^copilot_[0-9a-f]{32}$/;

export const CopilotAgentIdSchema = z.string().regex(COPILOT_AGENT_ID_RE);
export const CopilotOperationIdSchema = z.string().uuid();
export const CopilotOwnerKeySchema = AgentOwnerKeySchema;
export const CopilotExecutionTargetSchema = AgentExecutionTargetSchema;
export const CopilotResolvedTargetSchema = AgentResolvedTargetSchema;
export const CopilotOpaqueIdSchema = z.string().min(1).max(512);

export const CopilotPromptSchema = z
	.string()
	.refine((value) => value.trim().length > 0, "prompt must not be blank")
	.refine((value) => new TextEncoder().encode(value).byteLength <= COPILOT_PROMPT_MAX_BYTES, {
		message: `prompt must be at most ${COPILOT_PROMPT_MAX_BYTES} UTF-8 bytes`,
	});

export function sanitizeCopilotErrorText(raw: string): string {
	return sanitizeAgentErrorText(raw, COPILOT_ERROR_MAX_BYTES);
}

export const CopilotErrorTextSchema = boundedUtf8(COPILOT_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === sanitizeCopilotErrorText(value), "error must be normalized");

////////////////////////////////
//  Identity

export function copilotAgentIdForOperation(operationId: string): string {
	return agentIdForOperation("copilot", operationId);
}

/** What identifies a Copilot operation, with this family's legacy start spelling stamped on.
 *
 * The SOLE place that fact is written for Copilot, for the same reason as its Codex twin: the
 * service that mints a fingerprint and the schema that re-checks one must not hold different ideas
 * of which legacy spelling is tolerable. */
export function copilotOperationIdentity(
	fields: Omit<AgentOperationIdentity, "legacyModellessStart">,
): AgentOperationIdentity {
	// Copilot always appended a separator and the model, so a pre-migration MODEL-LESS start reads
	// `prompt + "\n"` where the shared encoding now writes `prompt`. That one recomputes exactly. A
	// pre-migration start that NAMED a model wrote the same bytes the shared encoding writes today,
	// so it verifies outright whenever the caller names the same model again.
	return { ...fields, legacyModellessStart: "trailing-separator" };
}

export function copilotOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return agentOperationFingerprint(kind, agentId, prompt);
}

////////////////////////////////
//  Activities and state

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

export const CopilotAgentStateSchema = z.enum(["creating", "idle", "working", "recovering", "unavailable"]);
export const CopilotTurnStateSchema = z.enum(["inProgress", "completed", "failed", "interrupted"]);
export const CopilotObservationSchema = z.enum([
	"accepted",
	"idle",
	"terminal",
	"waitTimedOut",
	"interruptRequested",
	"indeterminate",
	"unavailable",
]);
export const CopilotDeliverySchema = z.enum(["started", "followup"]);
export const CopilotErrorCodeSchema = z.enum([
	"invalid_input",
	"not_found",
	"feature_disabled",
	"daemon_unavailable",
	"app_server_unavailable",
	"authentication_required",
	"protocol_incompatible",
	"protocol_error",
	"indeterminate",
	"turn_failed",
	"agent_busy",
]);
export const CopilotDaemonFailureCodeSchema = z.enum([
	"daemon_unavailable",
	"app_server_unavailable",
	"authentication_required",
	"protocol_incompatible",
	"protocol_error",
]);
export const CopilotErrorSchema = z
	.object({
		code: CopilotErrorCodeSchema,
		message: CopilotErrorTextSchema,
		retryable: z.boolean(),
	})
	.strict();
export const CopilotRequestErrorSchema = z
	.object({
		error: CopilotErrorSchema.extend({ code: z.literal("invalid_input"), retryable: z.literal(false) }).strict(),
	})
	.strict();

////////////////////////////////
//  Durable agent state

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
		/** Start only. Copilot has always folded the model INTO its fingerprint but never stored it,
		 * so its records could not be re-checked at all; this is what makes the check below possible.
		 * Optional, so every pre-existing record still parses and is treated as unverifiable rather
		 * than dropped. */
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
			// The check Copilot never had. Codex's record has self-validated its fingerprints since it
			// shipped, so each backend held half of one guarantee: Codex recomputed a fingerprint that
			// was missing the model, Copilot computed one WITH the model and never recomputed it.
			// `unverifiable` is not an issue - see agentFingerprintVerdict for which record that is.
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

export const CopilotAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CopilotPersistedAgentSchema),
	})
	.strict();
export type CopilotPersistedAgent = z.infer<typeof CopilotPersistedAgentSchema>;
export type CopilotStoredOperation = z.infer<typeof CopilotStoredOperationSchema>;
export type CopilotStoredTurn = z.infer<typeof CopilotStoredTurnSchema>;
export type CopilotReconciliationFence = z.infer<typeof CopilotReconciliationFenceSchema>;
export type CopilotAgentCatalog = z.infer<typeof CopilotAgentCatalogSchema>;

export function restoreCopilotAgentCatalog(raw: unknown): CopilotAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = CopilotPersistedAgentSchema.safeParse(candidate);
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = CopilotAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}

////////////////////////////////
//  Public results and requests

export const CopilotAgentResultSchema = z
	.object({
		agentId: CopilotAgentIdSchema,
		agentState: CopilotAgentStateSchema,
		observation: CopilotObservationSchema,
		turn: z.object({ id: CopilotOpaqueIdSchema, state: CopilotTurnStateSchema }).strict().optional(),
		delivery: CopilotDeliverySchema.optional(),
		activities: CopilotActivitiesSchema,
		finalResponse: z.string().optional(),
		error: CopilotErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.delivery && !value.turn)
			ctx.addIssue({ code: "custom", message: "delivery requires an accepted turn", path: ["delivery"] });
		if (value.activities.length > 0 && !value.turn)
			ctx.addIssue({ code: "custom", message: "activities require a turn", path: ["activities"] });
		const creationTimedOut =
			value.observation === "waitTimedOut" && value.agentState === "creating" && !value.turn && !value.delivery;
		const requiresInProgressTurn =
			value.observation === "accepted" ||
			(value.observation === "waitTimedOut" && !creationTimedOut) ||
			value.observation === "interruptRequested";
		if (requiresInProgressTurn && value.turn?.state !== "inProgress")
			ctx.addIssue({
				code: "custom",
				message: `${value.observation} requires an in-progress turn`,
				path: ["turn"],
			});
		if (value.observation === "accepted" && !value.delivery)
			ctx.addIssue({ code: "custom", message: "accepted observation requires delivery", path: ["delivery"] });
		if (requiresInProgressTurn && value.agentState !== "working")
			ctx.addIssue({
				code: "custom",
				message: `${value.observation} requires a working agent`,
				path: ["agentState"],
			});
		if (value.observation === "idle" && (value.agentState !== "idle" || value.turn || value.delivery))
			ctx.addIssue({
				code: "custom",
				message: "idle observation cannot carry active delivery",
				path: ["observation"],
			});
		if (
			value.observation === "terminal" &&
			(!value.turn || value.turn.state === "inProgress" || value.agentState !== "idle")
		)
			ctx.addIssue({
				code: "custom",
				message: "terminal observation requires an idle agent and terminal turn",
				path: ["turn"],
			});
		if (
			value.finalResponse !== undefined &&
			(value.observation !== "terminal" || value.turn?.state !== "completed")
		)
			ctx.addIssue({
				code: "custom",
				message: "final response requires a completed terminal observation",
				path: ["finalResponse"],
			});
		if (value.observation === "terminal" && value.turn?.state === "completed" && value.finalResponse === undefined)
			ctx.addIssue({ code: "custom", message: "completed terminal turn requires its final response" });
		if (value.observation === "terminal" && value.turn?.state === "failed" && value.error?.code !== "turn_failed")
			ctx.addIssue({ code: "custom", message: "failed turn requires a turn_failed error", path: ["error"] });
		if (value.error?.code === "turn_failed" && value.turn?.state !== "failed")
			ctx.addIssue({ code: "custom", message: "turn_failed error requires a failed turn", path: ["error"] });
		if (value.observation === "terminal" && value.turn?.state !== "failed" && value.error)
			ctx.addIssue({ code: "custom", message: "only a failed terminal turn carries an error", path: ["error"] });
		if (value.observation === "unavailable") {
			const contextless = value.error?.code === "not_found";
			const infrastructureError =
				value.error?.code === "daemon_unavailable" ||
				value.error?.code === "app_server_unavailable" ||
				value.error?.code === "authentication_required" ||
				value.error?.code === "protocol_incompatible" ||
				value.error?.code === "protocol_error";
			if (
				contextless &&
				(value.agentState !== "unavailable" ||
					value.turn ||
					value.delivery ||
					value.activities.length ||
					value.finalResponse !== undefined)
			)
				ctx.addIssue({
					code: "custom",
					message: "contextless errors cannot claim agent activity",
					path: ["error"],
				});
			if (infrastructureError && value.agentState !== "unavailable" && value.agentState !== "recovering")
				ctx.addIssue({
					code: "custom",
					message: "infrastructure errors require unavailable agent state",
					path: ["agentState"],
				});
			if (!value.error)
				ctx.addIssue({ code: "custom", message: "unavailable observation requires an error", path: ["error"] });
			if (!contextless && !infrastructureError && value.error?.code !== "feature_disabled")
				ctx.addIssue({
					code: "custom",
					message: "error code does not describe unavailability",
					path: ["error"],
				});
		}
		if (value.observation === "indeterminate" && value.error?.code !== "indeterminate")
			ctx.addIssue({
				code: "custom",
				message: "indeterminate observation requires an indeterminate error",
				path: ["error"],
			});
		if (
			value.observation === "indeterminate" &&
			(value.turn ||
				value.delivery ||
				value.activities.length ||
				(value.agentState !== "recovering" && value.agentState !== "unavailable"))
		)
			ctx.addIssue({
				code: "custom",
				message: "indeterminate delivery cannot claim a native turn",
				path: ["observation"],
			});
		const errorAllowed =
			value.observation === "unavailable" ||
			value.observation === "indeterminate" ||
			(value.observation === "terminal" && value.turn?.state === "failed");
		if (value.error && !errorAllowed)
			ctx.addIssue({ code: "custom", message: "observation does not allow an error", path: ["error"] });
	});

export const CopilotListAgentSchema = z
	.object({
		agentId: CopilotAgentIdSchema,
		agentState: CopilotAgentStateSchema,
		activeTurnId: CopilotOpaqueIdSchema.optional(),
		turns: z.array(z.object({ id: CopilotOpaqueIdSchema, state: CopilotTurnStateSchema }).strict()),
		operations: z.array(
			z
				.object({
					kind: z.enum(["start", "message", "stop"]),
					state: z.string(),
					prompt: z.string().optional(),
				})
				.strict(),
		),
	})
	.strict();
export const CopilotListAgentsResultSchema = z.object({ agents: z.array(CopilotListAgentSchema) }).strict();

export type CopilotListAgent = z.infer<typeof CopilotListAgentSchema>;
export type CopilotListAgentsResult = z.infer<typeof CopilotListAgentsResultSchema>;

/**
 * What a producer must supply to be listed, which is deliberately NARROWER than any record it holds.
 *
 * Two producers feed this list and they name their history differently: the gateway's persisted
 * agent calls it `operations`, the session's own runtime calls it `exchanges` and carries the richer
 * Codex shape beside it. Both used to map to the public shape by hand, in their own file, against
 * a `.parse(unknown)` seam the compiler could not see through - so one of them silently stopped
 * matching and `copilotListAgents` threw on every non-empty list, which is what makes a spawned
 * agent's id unrecoverable. Naming the input here is what makes a mismatch a compile error.
 */
export interface CopilotListAgentSource {
	agentId: string;
	agentState: z.infer<typeof CopilotAgentStateSchema>;
	activeTurnId?: string;
	turns: ReadonlyArray<{ id: string; state: z.infer<typeof CopilotTurnStateSchema> }>;
	operations: ReadonlyArray<{ kind: "start" | "message" | "stop"; state: string; prompt?: string }>;
}

/** Builds the caller-visible row by explicitly copying only public fields. Sole owner of that set. */
export function projectCopilotListAgent(agent: CopilotListAgentSource): CopilotListAgent {
	return CopilotListAgentSchema.parse({
		agentId: agent.agentId,
		agentState: agent.agentState,
		...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
		turns: agent.turns.map((turn) => ({ id: turn.id, state: turn.state })),
		operations: agent.operations.map((operation) => ({
			kind: operation.kind,
			state: operation.state,
			...(operation.prompt ? { prompt: operation.prompt } : {}),
		})),
	});
}

export function projectCopilotListResult(agents: readonly CopilotListAgentSource[]): CopilotListAgentsResult {
	return CopilotListAgentsResultSchema.parse({ agents: agents.map(projectCopilotListAgent) });
}

export const CopilotStartAgentInputSchema = z
	.object({
		prompt: CopilotPromptSchema,
		model: z.string().min(1).max(128).optional(),
		cwd: z.string().min(1).max(512).optional(),
	})
	.strict();
export const CopilotMessageAgentInputSchema = z
	.object({ agentId: CopilotAgentIdSchema, prompt: CopilotPromptSchema })
	.strict();
export const CopilotAwaitAgentInputSchema = z.object({ agentId: CopilotAgentIdSchema }).strict();
export const CopilotStopAgentInputSchema = z.object({ agentId: CopilotAgentIdSchema }).strict();
export const CopilotListAgentsInputSchema = z.object({}).strict();
export const CopilotGatewayRequestSchema = z.discriminatedUnion("kind", [
	CopilotStartAgentInputSchema.extend({ kind: z.literal("start"), operationId: CopilotOperationIdSchema }).strict(),
	CopilotMessageAgentInputSchema.extend({
		kind: z.literal("message"),
		operationId: CopilotOperationIdSchema,
	}).strict(),
	CopilotAwaitAgentInputSchema.extend({ kind: z.literal("await") }).strict(),
	CopilotStopAgentInputSchema.extend({ kind: z.literal("stop"), operationId: CopilotOperationIdSchema }).strict(),
	CopilotListAgentsInputSchema.extend({ kind: z.literal("list") }).strict(),
]);

////////////////////////////////
//  Daemon relay

const CopilotDaemonCommandBase = {
	type: z.literal("copilot_command"),
	requestId: CopilotOperationIdSchema,
	ownerKey: CopilotOwnerKeySchema,
	agentId: CopilotAgentIdSchema,
};

export const CopilotDaemonCommandSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...CopilotDaemonCommandBase,
			kind: z.literal("start"),
			operationId: CopilotOperationIdSchema,
			target: CopilotExecutionTargetSchema,
			prompt: CopilotPromptSchema,
			model: z.string().min(1).max(128).optional(),
		})
		.strict(),
	z
		.object({
			...CopilotDaemonCommandBase,
			kind: z.literal("message"),
			operationId: CopilotOperationIdSchema,
			target: CopilotResolvedTargetSchema,
			sessionId: CopilotOpaqueIdSchema,
			prompt: CopilotPromptSchema,
		})
		.strict(),
	z
		.object({
			...CopilotDaemonCommandBase,
			kind: z.literal("interrupt"),
			operationId: CopilotOperationIdSchema,
			target: CopilotResolvedTargetSchema,
			sessionId: CopilotOpaqueIdSchema,
			turnId: CopilotOpaqueIdSchema,
		})
		.strict(),
	z
		.object({
			...CopilotDaemonCommandBase,
			kind: z.literal("reconcile"),
			target: CopilotResolvedTargetSchema,
			sessionId: CopilotOpaqueIdSchema,
			turnId: CopilotOpaqueIdSchema.optional(),
		})
		.strict(),
]);

const Fenced = {
	type: z.literal("copilot_event"),
	ownerKey: CopilotOwnerKeySchema,
	daemonInstanceId: CopilotOpaqueIdSchema,
	targetId: CopilotOpaqueIdSchema,
	generation: z.number().int().nonnegative(),
	eventId: z.number().int().nonnegative(),
	agentId: CopilotAgentIdSchema,
	sessionId: CopilotOpaqueIdSchema,
	turnId: CopilotOpaqueIdSchema,
};
export const CopilotDaemonEventSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...Fenced,
			kind: z.literal("activity"),
			itemId: CopilotOpaqueIdSchema,
			text: boundedUtf8(COPILOT_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z
		.object({
			...Fenced,
			kind: z.literal("terminal"),
			state: z.enum(["completed", "failed", "interrupted"]),
			finalResponse: z.string().optional(),
			error: CopilotErrorTextSchema.optional(),
		})
		.strict(),
]);

const ReceiptFenced = {
	type: z.literal("copilot_receipt"),
	requestId: CopilotOperationIdSchema,
	ownerKey: CopilotOwnerKeySchema,
	daemonInstanceId: CopilotOpaqueIdSchema,
	targetId: CopilotOpaqueIdSchema,
	generation: z.number().int().nonnegative(),
	eventId: z.number().int().nonnegative(),
	agentId: CopilotAgentIdSchema,
};
export const CopilotDaemonReceiptSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...ReceiptFenced,
			kind: z.literal("accepted"),
			operationId: CopilotOperationIdSchema,
			resolvedTarget: CopilotResolvedTargetSchema,
			sessionId: CopilotOpaqueIdSchema,
			turnId: CopilotOpaqueIdSchema,
			delivery: CopilotDeliverySchema,
		})
		.strict(),
	z
		.object({
			...ReceiptFenced,
			kind: z.literal("interruptResult"),
			operationId: CopilotOperationIdSchema,
			sessionId: CopilotOpaqueIdSchema,
			turnId: CopilotOpaqueIdSchema,
			ok: z.literal(true),
		})
		.strict(),
	z
		.object({
			...ReceiptFenced,
			kind: z.literal("reconciled"),
			sessionId: CopilotOpaqueIdSchema,
			turnId: CopilotOpaqueIdSchema.optional(),
			active: z.boolean(),
		})
		.strict(),
	z
		.object({
			type: z.literal("copilot_receipt"),
			kind: z.literal("rejected"),
			requestId: CopilotOperationIdSchema,
			ownerKey: CopilotOwnerKeySchema,
			daemonInstanceId: CopilotOpaqueIdSchema,
			agentId: CopilotAgentIdSchema,
			operationId: CopilotOperationIdSchema.optional(),
			eventId: z.number().int().nonnegative(),
			failureCode: CopilotDaemonFailureCodeSchema.optional(),
			error: CopilotErrorTextSchema,
		})
		.strict(),
]);

export const CopilotDaemonHelloSchema = z
	.object({
		type: z.literal("copilot_hello"),
		daemonInstanceId: CopilotOpaqueIdSchema,
		targets: z.array(
			z.object({ targetId: CopilotOpaqueIdSchema, generation: z.number().int().nonnegative() }).strict(),
		),
	})
	.strict();
export const CopilotEventAckSchema = z
	.object({
		type: z.literal("copilot_ack"),
		daemonInstanceId: CopilotOpaqueIdSchema,
		targetId: CopilotOpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		throughEventId: z.number().int().nonnegative(),
	})
	.strict();

export type CopilotAgentResult = z.infer<typeof CopilotAgentResultSchema>;
export type CopilotDaemonFailureCode = z.infer<typeof CopilotDaemonFailureCodeSchema>;
export type CopilotErrorCode = z.infer<typeof CopilotErrorCodeSchema>;
export type CopilotGatewayRequest = z.infer<typeof CopilotGatewayRequestSchema>;
export type CopilotDaemonCommand = z.infer<typeof CopilotDaemonCommandSchema>;
export type CopilotDaemonEvent = z.infer<typeof CopilotDaemonEventSchema>;
export type CopilotDaemonReceipt = z.infer<typeof CopilotDaemonReceiptSchema>;
export type CopilotDaemonHello = z.infer<typeof CopilotDaemonHelloSchema>;
export type CopilotEventAck = z.infer<typeof CopilotEventAckSchema>;
export type CopilotExecutionTarget = z.infer<typeof CopilotExecutionTargetSchema>;
export type CopilotResolvedTarget = z.infer<typeof CopilotResolvedTargetSchema>;

/**
 * Whether losing one daemon message would change what an owner believes about an outcome.
 *
 * Stated per kind and keyed by the unions themselves, so a new kind added above without an entry
 * here fails the build. Activity is best-effort: retaining it fills the outbox with narration and
 * evicts the receipts that carry outcomes.
 */
export const COPILOT_RELIABLE_EVENT_KIND: Record<CopilotDaemonEvent["kind"], boolean> = {
	activity: false,
	terminal: true,
};
export const COPILOT_RELIABLE_RECEIPT_KIND: Record<CopilotDaemonReceipt["kind"], boolean> = {
	accepted: true,
	rejected: false,
	interruptResult: true,
	reconciled: true,
};

export function isReliableCopilotMessage(message: CopilotDaemonEvent | CopilotDaemonReceipt): boolean {
	return message.type === "copilot_event"
		? COPILOT_RELIABLE_EVENT_KIND[message.kind]
		: COPILOT_RELIABLE_RECEIPT_KIND[message.kind];
}

export type CopilotAgentId = z.infer<typeof CopilotAgentIdSchema>;
