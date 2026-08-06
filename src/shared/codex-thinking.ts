import crypto from "node:crypto";
import { z } from "zod";
import { isComposite, isSlug, parseSessionName } from "./session-id.js";

export const CODEX_PROMPT_MAX_BYTES = 256 * 1024;
export const CODEX_ACTIVITY_MAX_BYTES = 16 * 1024;
export const CODEX_ACTIVITY_MAX_ITEMS = 32;
export const CODEX_ERROR_MAX_BYTES = 16 * 1024;
export const CODEX_AGENT_ID_RE = /^codex_[0-9a-f]{32}$/;
/**
 * How long a waiting Codex call holds its HTTP connection.
 *
 * Bounded by what the CLIENT survives, not by how long a turn might take. Node's fetch abandons a
 * silent connection after 300s - measured, it throws UND_ERR_HEADERS_TIMEOUT at 301s - and
 * `routerPost` reads that as a network failure and re-posts. Since a replayed operation is never
 * re-dispatched, every retry just waits again, so a longer hold could never deliver its answer at
 * all. Raising the client limit would mean an undici `Agent`, which is not a dependency of this
 * package and resolves on the host only by accident, so the server holds for less instead.
 *
 * A turn outliving this budget is not lost: it keeps running and `codexAwaitAgent` collects it.
 */
export const CODEX_WAIT_BUDGET_MS = 240_000;
/** Deliberately not the App Server's own default: a thread runs whatever tier this names, so leaving
 * the choice to the server would silently change what a delegated sub-task is worth. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";

const OpaqueIdSchema = z.string().min(1).max(512);
export const CodexOperationIdSchema = z.string().uuid();
const OperationIdSchema = CodexOperationIdSchema;

function boundedUtf8(maxBytes: number, name: string) {
	return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
		message: `${name} must be at most ${maxBytes} UTF-8 bytes`,
	});
}

/** Normalizes untrusted daemon errors before they enter durable or caller-visible state. */
export function sanitizeCodexErrorText(raw: string): string {
	const normalized = raw
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (new TextEncoder().encode(normalized).byteLength <= CODEX_ERROR_MAX_BYTES) return normalized;

	let result = "";
	let bytes = 0;
	for (const character of normalized) {
		const characterBytes = new TextEncoder().encode(character).byteLength;
		if (bytes + characterBytes > CODEX_ERROR_MAX_BYTES) break;
		result += character;
		bytes += characterBytes;
	}
	return result.trimEnd();
}

export const CodexErrorTextSchema = boundedUtf8(CODEX_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === sanitizeCodexErrorText(value), "error must be normalized");

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

export const CodexAgentIdSchema = z.string().regex(CODEX_AGENT_ID_RE);
export const CodexOwnerKeySchema = z
	.string()
	.min(3)
	.max(129)
	.refine((value) => {
		if (!isComposite(value)) return false;
		const { project, session } = parseSessionName(value);
		return isSlug(project) && isSlug(session);
	}, "owner key must contain two canonical slugs");
export const CodexPromptSchema = z
	.string()
	.refine((value) => value.trim().length > 0, "prompt must not be blank")
	.refine((value) => new TextEncoder().encode(value).byteLength <= CODEX_PROMPT_MAX_BYTES, {
		message: `prompt must be at most ${CODEX_PROMPT_MAX_BYTES} UTF-8 bytes`,
	});

/**
 * The agent ID a start operation will use, derived from the operation ID rather than minted fresh.
 *
 * This is what makes a start retry idempotent. The stored fingerprint covers the agent ID, so a
 * retry that minted a new one would fingerprint differently and be refused as a conflicting reuse of
 * the operation ID instead of replaying the committed result. Deriving it means the same invocation
 * always names the same agent, however many times its HTTP call is retried.
 *
 * Predictability costs nothing here: an operation ID is private to the gateway and never reaches
 * Claude, and ownership is enforced by session authority rather than by the ID being unguessable.
 */
export function codexAgentIdForOperation(operationId: string): string {
	const digest = crypto.createHash("sha256").update(`CODEX_AGENT_V1\n${operationId}`).digest("hex");
	return `codex_${digest.slice(0, 32)}`;
}

export function codexOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify([kind, agentId, prompt ?? null]))
		.digest("hex");
}

export const CodexAgentStateSchema = z.enum(["creating", "idle", "working", "recovering", "unavailable"]);
export const CodexTurnStateSchema = z.enum(["inProgress", "completed", "failed", "interrupted"]);
export const CodexObservationSchema = z.enum([
	"accepted",
	"idle",
	"terminal",
	"waitTimedOut",
	"interruptRequested",
	"indeterminate",
	"unavailable",
]);
export const CodexDeliverySchema = z.enum(["started", "steered"]);
export const CodexErrorCodeSchema = z.enum([
	"invalid_input",
	"not_found",
	"feature_disabled",
	"daemon_unavailable",
	"app_server_unavailable",
	"interrupt_in_progress",
	"protocol_incompatible",
	"protocol_error",
	"indeterminate",
	"turn_failed",
]);
export const CodexErrorSchema = z
	.object({
		code: CodexErrorCodeSchema,
		message: CodexErrorTextSchema,
		retryable: z.boolean(),
	})
	.strict();
export const CodexRequestErrorSchema = z
	.object({
		error: CodexErrorSchema.extend({
			code: z.literal("invalid_input"),
			retryable: z.literal(false),
		}).strict(),
	})
	.strict();
const CodexListAvailabilityErrorSchema = CodexErrorSchema.extend({
	code: z.enum(["daemon_unavailable", "app_server_unavailable", "protocol_incompatible", "protocol_error"]),
}).strict();

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

export const CodexAgentResultSchema = z
	.object({
		agentId: CodexAgentIdSchema,
		agentState: CodexAgentStateSchema,
		observation: CodexObservationSchema,
		turn: z
			.object({
				id: OpaqueIdSchema,
				state: CodexTurnStateSchema,
			})
			.strict()
			.optional(),
		delivery: CodexDeliverySchema.optional(),
		activities: CodexActivitiesSchema,
		finalResponse: z.string().optional(),
		error: CodexErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.delivery && !value.turn) {
			ctx.addIssue({ code: "custom", message: "delivery requires an accepted turn", path: ["delivery"] });
		}
		if (value.activities.length > 0 && !value.turn) {
			ctx.addIssue({ code: "custom", message: "activities require a turn", path: ["activities"] });
		}
		const creationTimedOut =
			value.observation === "waitTimedOut" && value.agentState === "creating" && !value.turn && !value.delivery;
		const requireInProgressTurn =
			value.observation === "accepted" ||
			(value.observation === "waitTimedOut" && !creationTimedOut) ||
			value.observation === "interruptRequested";
		if (requireInProgressTurn && value.turn?.state !== "inProgress") {
			ctx.addIssue({
				code: "custom",
				message: `${value.observation} requires an in-progress turn`,
				path: ["turn"],
			});
		}
		if (value.observation === "accepted" && !value.delivery) {
			ctx.addIssue({ code: "custom", message: "accepted observation requires delivery", path: ["delivery"] });
		}
		if (requireInProgressTurn && value.agentState !== "working") {
			ctx.addIssue({
				code: "custom",
				message: `${value.observation} requires a working agent`,
				path: ["agentState"],
			});
		}
		if (value.observation === "idle" && (value.agentState !== "idle" || value.turn || value.delivery)) {
			ctx.addIssue({
				code: "custom",
				message: "idle observation cannot carry active delivery",
				path: ["observation"],
			});
		}
		if (
			value.observation === "terminal" &&
			(!value.turn || value.turn.state === "inProgress" || value.agentState !== "idle")
		) {
			ctx.addIssue({
				code: "custom",
				message: "terminal observation requires an idle agent and terminal turn",
				path: ["turn"],
			});
		}
		if (
			value.finalResponse !== undefined &&
			(value.observation !== "terminal" || value.turn?.state !== "completed")
		) {
			ctx.addIssue({
				code: "custom",
				message: "final response requires a completed terminal observation",
				path: ["finalResponse"],
			});
		}
		if (
			value.observation === "terminal" &&
			value.turn?.state === "completed" &&
			value.finalResponse === undefined
		) {
			ctx.addIssue({ code: "custom", message: "completed terminal turn requires its final response" });
		}
		if (value.observation === "terminal" && value.turn?.state === "failed" && value.error?.code !== "turn_failed") {
			ctx.addIssue({ code: "custom", message: "failed turn requires a turn_failed error", path: ["error"] });
		}
		if (value.error?.code === "turn_failed" && value.turn?.state !== "failed") {
			ctx.addIssue({ code: "custom", message: "turn_failed error requires a failed turn", path: ["error"] });
		}
		if (value.observation === "terminal" && value.turn?.state !== "failed" && value.error) {
			ctx.addIssue({ code: "custom", message: "only a failed terminal turn carries an error", path: ["error"] });
		}
		if (value.observation === "unavailable") {
			const contextless = value.error?.code === "not_found";
			const featureDisabled = value.error?.code === "feature_disabled";
			const interruptBlocked = value.error?.code === "interrupt_in_progress";
			const infrastructureError =
				value.error?.code === "daemon_unavailable" ||
				value.error?.code === "app_server_unavailable" ||
				value.error?.code === "protocol_incompatible" ||
				value.error?.code === "protocol_error";
			if (
				contextless &&
				(value.agentState !== "unavailable" ||
					value.turn ||
					value.delivery ||
					value.activities.length ||
					value.finalResponse !== undefined)
			) {
				ctx.addIssue({
					code: "custom",
					message: "contextless errors cannot claim agent activity",
					path: ["error"],
				});
			}
			if (infrastructureError && value.agentState !== "unavailable" && value.agentState !== "recovering") {
				ctx.addIssue({
					code: "custom",
					message: "infrastructure errors require unavailable agent state",
					path: ["agentState"],
				});
			}
			if (featureDisabled && value.delivery) {
				ctx.addIssue({
					code: "custom",
					message: "disabled work cannot claim native delivery",
					path: ["delivery"],
				});
			}
			if (
				interruptBlocked &&
				(value.agentState !== "working" || value.turn?.state !== "inProgress" || value.delivery)
			) {
				ctx.addIssue({
					code: "custom",
					message: "interrupt_in_progress requires the blocked active turn",
					path: ["error"],
				});
			}
			if (!value.error)
				ctx.addIssue({ code: "custom", message: "unavailable observation requires an error", path: ["error"] });
			if (!contextless && !featureDisabled && !interruptBlocked && !infrastructureError) {
				ctx.addIssue({
					code: "custom",
					message: "error code does not describe unavailability",
					path: ["error"],
				});
			}
		}
		if (value.observation === "indeterminate" && value.error?.code !== "indeterminate") {
			ctx.addIssue({
				code: "custom",
				message: "indeterminate observation requires an indeterminate error",
				path: ["error"],
			});
		}
		if (
			value.observation === "indeterminate" &&
			(value.turn ||
				value.delivery ||
				value.activities.length ||
				(value.agentState !== "recovering" && value.agentState !== "unavailable"))
		) {
			ctx.addIssue({
				code: "custom",
				message: "indeterminate delivery cannot claim a native turn",
				path: ["observation"],
			});
		}
		if (
			value.observation === "interruptRequested" &&
			value.error?.code !== "interrupt_in_progress" &&
			value.error
		) {
			ctx.addIssue({
				code: "custom",
				message: "interrupt request only allows an interrupt_in_progress error",
				path: ["error"],
			});
		}
		if (value.observation === "interruptRequested" && value.delivery) {
			ctx.addIssue({
				code: "custom",
				message: "an interrupt request cannot report start or steer delivery",
				path: ["delivery"],
			});
		}
		const errorAllowed =
			value.observation === "unavailable" ||
			value.observation === "indeterminate" ||
			value.observation === "interruptRequested" ||
			(value.observation === "terminal" && value.turn?.state === "failed");
		if (value.error && !errorAllowed) {
			ctx.addIssue({ code: "custom", message: "observation does not allow an error", path: ["error"] });
		}
	});

export const CodexStartAgentInputSchema = z
	.object({
		prompt: CodexPromptSchema,
		awaitResponse: z.boolean().optional().default(true),
	})
	.strict();

export const CodexMessageAgentInputSchema = z
	.object({
		agentId: CodexAgentIdSchema,
		prompt: CodexPromptSchema,
		awaitResponse: z.boolean().optional().default(true),
	})
	.strict();

export const CodexAwaitAgentInputSchema = z.object({ agentId: CodexAgentIdSchema }).strict();
export const CodexStopAgentInputSchema = z.object({ agentId: CodexAgentIdSchema }).strict();
export const CodexListAgentsInputSchema = z.object({}).strict();

export const CodexGatewayRequestSchema = z.discriminatedUnion("kind", [
	CodexStartAgentInputSchema.extend({ kind: z.literal("start"), operationId: OperationIdSchema }).strict(),
	CodexMessageAgentInputSchema.extend({ kind: z.literal("message"), operationId: OperationIdSchema }).strict(),
	CodexAwaitAgentInputSchema.extend({ kind: z.literal("await") }).strict(),
	CodexStopAgentInputSchema.extend({ kind: z.literal("stop"), operationId: OperationIdSchema }).strict(),
	CodexListAgentsInputSchema.extend({ kind: z.literal("list") }).strict(),
]);

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

export const CodexStoredTurnSchema = z.discriminatedUnion("state", [
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("inProgress"),
			activities: CodexStoredActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("completed"),
			activities: CodexStoredActivitiesSchema,
			finalItemId: OpaqueIdSchema.optional(),
			finalResponse: z.string(),
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("failed"),
			activities: CodexStoredActivitiesSchema,
			error: CodexErrorTextSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("interrupted"),
			activities: CodexStoredActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
]);

const CodexExchangeFields = {
	kind: z.enum(["start", "message"]),
	prompt: CodexPromptSchema,
	status: z.enum(["requested", "accepted", "indeterminate"]),
	delivery: CodexDeliverySchema.optional(),
	turnId: OpaqueIdSchema.optional(),
	createdAt: z.number().int().nonnegative(),
	acceptedAt: z.number().int().nonnegative().optional(),
};

export const CodexListExchangeSchema = z
	.object(CodexExchangeFields)
	.strict()
	.superRefine((value, ctx) => {
		if (value.acceptedAt !== undefined && value.acceptedAt < value.createdAt) {
			ctx.addIssue({ code: "custom", message: "exchange acceptance cannot predate creation" });
		}
		const accepted = value.status === "accepted";
		if (
			accepted !== (value.delivery !== undefined) ||
			accepted !== (value.turnId !== undefined) ||
			accepted !== (value.acceptedAt !== undefined)
		) {
			ctx.addIssue({ code: "custom", message: "accepted exchange requires delivery, turn, and timestamp" });
		}
		if (value.kind === "start" && value.delivery !== undefined && value.delivery !== "started") {
			ctx.addIssue({ code: "custom", message: "start exchange must start its native turn" });
		}
	});

export const CodexStoredExchangeSchema = CodexListExchangeSchema.safeExtend({
	exchangeId: OperationIdSchema,
	operationId: OperationIdSchema,
}).strict();

export const CodexReconciliationFenceSchema = z
	.object({
		daemonInstanceId: OpaqueIdSchema,
		targetId: OpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		lastEventId: z.number().int().nonnegative(),
	})
	.strict();

export const CodexStoredOperationSchema = z
	.object({
		operationId: OperationIdSchema,
		kind: z.enum(["start", "message", "stop"]),
		fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		state: z.enum(["requested", "accepted", "indeterminate"]),
		turnId: OpaqueIdSchema.optional(),
		expectedTurnId: OpaqueIdSchema.optional(),
		acceptanceFence: CodexReconciliationFenceSchema.optional(),
		acceptanceUnverified: z.literal(true).optional(),
		preDispatch: z
			.object({
				agentState: CodexAgentStateSchema,
				threadId: OpaqueIdSchema.optional(),
				turnId: OpaqueIdSchema.optional(),
				fence: CodexReconciliationFenceSchema.optional(),
			})
			.strict(),
		noOp: z.literal(true).optional(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.updatedAt < value.createdAt) {
			ctx.addIssue({ code: "custom", message: "operation update cannot predate creation" });
		}
		if ((value.kind === "start" || value.kind === "message") && value.state === "accepted" && !value.turnId) {
			ctx.addIssue({ code: "custom", message: "accepted start and message operations require a turn" });
		}
		if (value.kind !== "stop" && value.noOp) {
			ctx.addIssue({ code: "custom", message: "only a stop operation can be a no-op" });
		}
		if (value.kind !== "message" && value.expectedTurnId) {
			ctx.addIssue({ code: "custom", message: "only a message operation can carry an expected turn" });
		}
		if (value.state !== "accepted" && value.acceptanceFence) {
			ctx.addIssue({ code: "custom", message: "only an accepted operation can retain an acceptance fence" });
		}
		if (
			value.acceptanceUnverified &&
			(value.state !== "accepted" || value.kind === "stop" || value.acceptanceFence)
		) {
			ctx.addIssue({ code: "custom", message: "unverified acceptance must be an unfenced prompt delivery" });
		}
		if (
			(value.kind === "start" || value.kind === "message") &&
			value.state === "accepted" &&
			!value.acceptanceFence &&
			!value.acceptanceUnverified
		) {
			ctx.addIssue({ code: "custom", message: "accepted prompt delivery requires its receipt fence" });
		}
		if (value.kind === "start" && value.preDispatch.agentState !== "creating") {
			ctx.addIssue({ code: "custom", message: "start operation requires a creating pre-dispatch state" });
		}
		if (
			value.kind === "start" &&
			(value.preDispatch.threadId || value.preDispatch.turnId || value.preDispatch.fence)
		) {
			ctx.addIssue({ code: "custom", message: "start operation cannot expect native identifiers" });
		}
		if (
			value.kind !== "start" &&
			(!value.preDispatch.threadId || (!value.preDispatch.fence && !value.acceptanceUnverified))
		) {
			ctx.addIssue({
				code: "custom",
				message: "existing-agent operation requires its expected thread and fence",
			});
		}
		if (
			value.kind !== "start" &&
			value.preDispatch.agentState !== "idle" &&
			value.preDispatch.agentState !== "working"
		) {
			ctx.addIssue({ code: "custom", message: "existing-agent operation requires an operational prior state" });
		}
		if (value.preDispatch.agentState === "idle" && value.preDispatch.turnId) {
			ctx.addIssue({ code: "custom", message: "idle pre-dispatch state cannot carry an active turn" });
		}
		if (value.kind !== "start" && value.preDispatch.agentState === "working" && !value.preDispatch.turnId) {
			ctx.addIssue({ code: "custom", message: "working pre-dispatch state requires its active turn" });
		}
		if (value.kind === "message" && value.expectedTurnId !== value.preDispatch.turnId) {
			ctx.addIssue({ code: "custom", message: "expected turn must match the pre-dispatch turn" });
		}
		if (value.kind === "stop") {
			const acceptedNoOp = value.state === "accepted" && value.noOp === true && !value.turnId;
			const targeted = value.noOp === undefined && value.turnId !== undefined;
			if (!acceptedNoOp && !targeted) {
				ctx.addIssue({ code: "custom", message: "stop operation requires a target turn or an accepted no-op" });
			}
			if (targeted && value.turnId !== value.preDispatch.turnId) {
				ctx.addIssue({ code: "custom", message: "stop target must match the pre-dispatch turn" });
			}
		}
	});

export interface CodexAgentHistoryView {
	agentState: z.infer<typeof CodexAgentStateSchema>;
	activeTurnId?: string;
	exchanges: ReadonlyArray<{
		kind: "start" | "message";
		status: "requested" | "accepted" | "indeterminate";
		delivery?: z.infer<typeof CodexDeliverySchema>;
		turnId?: string;
		createdAt: number;
		acceptedAt?: number;
	}>;
	turns: ReadonlyArray<{
		id: string;
		state: z.infer<typeof CodexTurnStateSchema>;
		updatedAt: number;
	}>;
	createdAt: number;
	updatedAt: number;
}

/** Cross-boundary history invariants shared by the private catalog and its public projection. */
export function codexAgentHistoryIssues(value: CodexAgentHistoryView): string[] {
	const issues: string[] = [];
	if (value.updatedAt < value.createdAt) issues.push("agent update cannot predate creation");

	const activeTurns = value.activeTurnId ? value.turns.filter((turn) => turn.id === value.activeTurnId) : [];
	const inProgressTurns = value.turns.filter((turn) => turn.state === "inProgress");
	if (
		value.activeTurnId &&
		(activeTurns.length !== 1 || activeTurns[0]?.state !== "inProgress" || inProgressTurns.length !== 1)
	) {
		issues.push("active turn must resolve to one in-progress turn");
	}
	if (!value.activeTurnId && inProgressTurns.length > 0) {
		issues.push("an in-progress turn must be the active turn");
	}
	if (value.agentState === "working" && !value.activeTurnId) issues.push("working agent requires an active turn");
	if (value.agentState === "idle" && value.activeTurnId) issues.push("idle agent cannot retain an active turn");
	if (new Set(value.turns.map((turn) => turn.id)).size !== value.turns.length) {
		issues.push("turn IDs must be unique");
	}

	if (
		value.exchanges.filter((exchange) => exchange.kind === "start").length !== 1 ||
		value.exchanges[0]?.kind !== "start"
	) {
		issues.push("history requires one leading start exchange");
	}
	const startedTurnIds = value.exchanges.flatMap((exchange) =>
		exchange.delivery === "started" && exchange.turnId ? [exchange.turnId] : [],
	);
	if (new Set(startedTurnIds).size !== startedTurnIds.length) {
		issues.push("a native turn can be started by only one exchange");
	}
	for (const turn of value.turns) {
		if (startedTurnIds.filter((turnId) => turnId === turn.id).length !== 1) {
			issues.push("every turn requires one starting exchange");
		}
	}

	for (const exchange of value.exchanges) {
		if (
			exchange.createdAt < value.createdAt ||
			exchange.createdAt > value.updatedAt ||
			(exchange.acceptedAt !== undefined && exchange.acceptedAt > value.updatedAt)
		) {
			issues.push("exchange timestamp is outside its agent lifetime");
		}
		if (exchange.turnId && !value.turns.some((turn) => turn.id === exchange.turnId)) {
			issues.push("exchange turn must exist");
		}
	}
	for (const turn of value.turns) {
		if (turn.updatedAt < value.createdAt || turn.updatedAt > value.updatedAt) {
			issues.push("turn timestamp is outside its agent lifetime");
		}
		const acceptedAt = value.exchanges.flatMap((exchange) =>
			exchange.turnId === turn.id && exchange.acceptedAt !== undefined ? [exchange.acceptedAt] : [],
		);
		if (acceptedAt.some((timestamp) => timestamp > turn.updatedAt)) {
			issues.push("turn cannot predate accepted delivery");
		}
	}

	if (
		value.agentState === "creating" &&
		(value.activeTurnId ||
			value.turns.length > 0 ||
			value.exchanges.length !== 1 ||
			value.exchanges[0]?.kind !== "start" ||
			value.exchanges[0]?.status !== "requested")
	) {
		issues.push("creating agent can contain only its requested start");
	}
	return issues;
}

export const CodexPersistedAgentSchema = z
	.object({
		version: z.literal(1),
		agentId: CodexAgentIdSchema,
		agentState: CodexAgentStateSchema,
		requestedTarget: CodexExecutionTargetSchema,
		resolvedTarget: CodexResolvedTargetSchema.optional(),
		threadId: OpaqueIdSchema.optional(),
		activeTurnId: OpaqueIdSchema.optional(),
		pendingInterrupt: z
			.object({
				operationId: OperationIdSchema,
				turnId: OpaqueIdSchema,
				requestedAt: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		exchanges: z.array(CodexStoredExchangeSchema),
		turns: z.array(CodexStoredTurnSchema),
		operations: z.array(CodexStoredOperationSchema),
		fence: CodexReconciliationFenceSchema.optional(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const message of codexAgentHistoryIssues(value)) ctx.addIssue({ code: "custom", message });
		if (!!value.resolvedTarget !== !!value.threadId) {
			ctx.addIssue({ code: "custom", message: "resolved target and thread ID must appear together" });
		}
		const hasNativeHistory =
			value.turns.length > 0 ||
			value.exchanges.some((exchange) => exchange.status === "accepted") ||
			value.operations.some(
				(operation) =>
					(operation.kind === "start" || operation.kind === "message") && operation.state === "accepted",
			);
		if (hasNativeHistory && (!value.resolvedTarget || !value.threadId)) {
			ctx.addIssue({ code: "custom", message: "native history requires its resolved target and thread" });
		}
		const hasUnverifiedAcceptance = value.operations.some((operation) => operation.acceptanceUnverified);
		if (hasNativeHistory && !hasUnverifiedAcceptance && !value.fence) {
			ctx.addIssue({ code: "custom", message: "verified native history requires its reconciliation fence" });
		}
		if (value.threadId && !hasNativeHistory) {
			ctx.addIssue({ code: "custom", message: "stored thread requires accepted native history" });
		}
		if (
			value.agentState === "creating" &&
			(hasNativeHistory || value.resolvedTarget || value.activeTurnId || value.pendingInterrupt || value.fence)
		) {
			ctx.addIssue({ code: "custom", message: "creating agent cannot contain native state" });
		}
		if (
			value.agentState === "creating" &&
			(value.operations.length !== 1 ||
				value.operations.some((operation) => operation.kind !== "start" || operation.state !== "requested"))
		) {
			ctx.addIssue({ code: "custom", message: "creating agent can contain only its requested start" });
		}
		if (value.agentState === "idle" && !value.threadId) {
			ctx.addIssue({ code: "custom", message: "idle agent requires its reusable thread" });
		}
		if (value.activeTurnId && !value.threadId) {
			ctx.addIssue({ code: "custom", message: "active turn requires a thread", path: ["activeTurnId"] });
		}
		if (value.pendingInterrupt && value.pendingInterrupt.turnId !== value.activeTurnId) {
			ctx.addIssue({ code: "custom", message: "pending interrupt must target the active turn" });
		}
		if (value.resolvedTarget && value.resolvedTarget.kind !== value.requestedTarget.kind) {
			ctx.addIssue({ code: "custom", message: "resolved target kind must match requested target" });
		}
		if (value.fence && (!value.resolvedTarget || value.fence.targetId !== value.resolvedTarget.targetId)) {
			ctx.addIssue({ code: "custom", message: "reconciliation fence must match a resolved target" });
		}
		if (new Set(value.exchanges.map((exchange) => exchange.exchangeId)).size !== value.exchanges.length) {
			ctx.addIssue({ code: "custom", message: "stored exchange IDs must be unique" });
		}
		if (new Set(value.exchanges.map((exchange) => exchange.operationId)).size !== value.exchanges.length) {
			ctx.addIssue({ code: "custom", message: "stored exchange operation IDs must be unique" });
		}
		if (new Set(value.operations.map((operation) => operation.operationId)).size !== value.operations.length) {
			ctx.addIssue({ code: "custom", message: "stored operation IDs must be unique" });
		}
		if (hasUnverifiedAcceptance && value.agentState !== "recovering" && value.agentState !== "unavailable") {
			ctx.addIssue({ code: "custom", message: "unverified acceptance requires recovery state" });
		}
		if (
			value.operations.filter((operation) => operation.kind === "start").length !== 1 ||
			value.operations[0]?.kind !== "start"
		) {
			ctx.addIssue({ code: "custom", message: "stored history requires one leading start operation" });
		}
		for (const exchange of value.exchanges) {
			const operation = value.operations.find((candidate) => candidate.operationId === exchange.operationId);
			if (!operation || operation.kind !== exchange.kind || operation.state !== exchange.status) {
				ctx.addIssue({ code: "custom", message: "stored exchange must match its operation" });
				continue;
			}
			if (operation.turnId !== exchange.turnId) {
				ctx.addIssue({ code: "custom", message: "stored exchange and operation must reference the same turn" });
			}
			if (operation.createdAt !== exchange.createdAt) {
				ctx.addIssue({ code: "custom", message: "stored exchange and operation must share request time" });
			}
			if (exchange.acceptedAt !== undefined && operation.updatedAt !== exchange.acceptedAt) {
				ctx.addIssue({ code: "custom", message: "stored acceptance timestamps must match" });
			}
			if (
				exchange.kind === "message" &&
				exchange.status === "accepted" &&
				operation.preDispatch.agentState === "idle" &&
				exchange.delivery !== "started"
			) {
				ctx.addIssue({ code: "custom", message: "message delivery must match its pre-dispatch state" });
			}
			if (
				exchange.kind === "message" &&
				exchange.delivery === "steered" &&
				(operation.preDispatch.agentState !== "working" || operation.expectedTurnId !== exchange.turnId)
			) {
				ctx.addIssue({ code: "custom", message: "steered message must match its expected turn" });
			}
			if (
				exchange.kind === "message" &&
				exchange.delivery === "started" &&
				operation.preDispatch.agentState === "working" &&
				(operation.expectedTurnId === exchange.turnId ||
					!value.turns.some((turn) => turn.id === operation.expectedTurnId && turn.state !== "inProgress"))
			) {
				ctx.addIssue({ code: "custom", message: "started message requires a settled expected turn" });
			}
			if (operation.fingerprint !== codexOperationFingerprint(exchange.kind, value.agentId, exchange.prompt)) {
				ctx.addIssue({ code: "custom", message: "stored prompt operation fingerprint does not match" });
			}
		}
		for (const operation of value.operations) {
			if (operation.createdAt < value.createdAt || operation.updatedAt > value.updatedAt) {
				ctx.addIssue({ code: "custom", message: "stored operation timestamp is outside its agent lifetime" });
			}
			if (
				(operation.kind === "start" || operation.kind === "message") &&
				!value.exchanges.some((exchange) => exchange.operationId === operation.operationId)
			) {
				ctx.addIssue({ code: "custom", message: "stored prompt operation requires its exchange" });
			}
			if (operation.turnId && !value.turns.some((turn) => turn.id === operation.turnId)) {
				ctx.addIssue({ code: "custom", message: "stored operation turn must exist" });
			}
			if (operation.expectedTurnId && !value.turns.some((turn) => turn.id === operation.expectedTurnId)) {
				ctx.addIssue({ code: "custom", message: "stored expected turn must exist" });
			}
			if (operation.preDispatch.threadId && operation.preDispatch.threadId !== value.threadId) {
				ctx.addIssue({ code: "custom", message: "pre-dispatch thread must match the stored native thread" });
			}
			if (
				operation.preDispatch.fence &&
				(!value.resolvedTarget || operation.preDispatch.fence.targetId !== value.resolvedTarget.targetId)
			) {
				ctx.addIssue({ code: "custom", message: "pre-dispatch fence must match the resolved target" });
			}
			if (
				operation.preDispatch.fence &&
				value.fence &&
				operation.preDispatch.fence.daemonInstanceId === value.fence.daemonInstanceId &&
				operation.preDispatch.fence.generation === value.fence.generation &&
				operation.preDispatch.fence.lastEventId > value.fence.lastEventId
			) {
				ctx.addIssue({ code: "custom", message: "pre-dispatch fence cannot outrun agent recovery" });
			}
			if (
				operation.acceptanceFence &&
				(!value.resolvedTarget || operation.acceptanceFence.targetId !== value.resolvedTarget.targetId)
			) {
				ctx.addIssue({ code: "custom", message: "operation acceptance fence must match the resolved target" });
			}
			if (
				operation.acceptanceFence &&
				value.fence &&
				operation.acceptanceFence.daemonInstanceId === value.fence.daemonInstanceId &&
				operation.acceptanceFence.generation === value.fence.generation &&
				operation.acceptanceFence.lastEventId > value.fence.lastEventId
			) {
				ctx.addIssue({ code: "custom", message: "operation acceptance fence cannot outrun agent recovery" });
			}
			if (operation.preDispatch.turnId && !value.turns.some((turn) => turn.id === operation.preDispatch.turnId)) {
				ctx.addIssue({ code: "custom", message: "pre-dispatch turn must exist" });
			}
			if (
				operation.kind === "stop" &&
				operation.fingerprint !== codexOperationFingerprint("stop", value.agentId)
			) {
				ctx.addIssue({ code: "custom", message: "stored stop operation fingerprint does not match" });
			}
		}
		if (value.pendingInterrupt) {
			if (
				value.pendingInterrupt.requestedAt < value.createdAt ||
				value.pendingInterrupt.requestedAt > value.updatedAt
			) {
				ctx.addIssue({ code: "custom", message: "pending interrupt timestamp is outside its agent lifetime" });
			}
			const operation = value.operations.find(
				(candidate) => candidate.operationId === value.pendingInterrupt?.operationId,
			);
			if (operation?.kind !== "stop" || operation.turnId !== value.pendingInterrupt.turnId) {
				ctx.addIssue({ code: "custom", message: "pending interrupt requires its stored stop operation" });
			}
			if (operation && operation.createdAt !== value.pendingInterrupt.requestedAt) {
				ctx.addIssue({ code: "custom", message: "pending interrupt and stop request timestamps must match" });
			}
		}
	});

export const CodexAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CodexPersistedAgentSchema),
	})
	.strict()
	.superRefine((value, ctx) => {
		const agentIds = new Set<string>();
		const operationIds = new Set<string>();
		for (const [index, agent] of value.agents.entries()) {
			if (agentIds.has(agent.agentId)) {
				ctx.addIssue({
					code: "custom",
					message: "agent IDs must be unique within an owner catalog",
					path: ["agents", index, "agentId"],
				});
			}
			agentIds.add(agent.agentId);
			for (const operation of agent.operations) {
				if (operationIds.has(operation.operationId)) {
					ctx.addIssue({
						code: "custom",
						message: "operation IDs must be unique within an owner catalog",
						path: ["agents", index, "operations"],
					});
				}
				operationIds.add(operation.operationId);
			}
		}
	});

export const CodexListTurnSchema = z.discriminatedUnion("state", [
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("inProgress"),
			activities: CodexActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("completed"),
			activities: CodexActivitiesSchema,
			finalResponse: z.string(),
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("failed"),
			activities: CodexActivitiesSchema,
			error: CodexErrorTextSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			id: OpaqueIdSchema,
			state: z.literal("interrupted"),
			activities: CodexActivitiesSchema,
			updatedAt: z.number().int().nonnegative(),
		})
		.strict(),
]);

export const CodexListAgentSchema = z
	.object({
		agentId: CodexAgentIdSchema,
		agentState: CodexAgentStateSchema,
		activeTurnId: OpaqueIdSchema.optional(),
		exchanges: z.array(CodexListExchangeSchema),
		turns: z.array(CodexListTurnSchema),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const message of codexAgentHistoryIssues(value)) ctx.addIssue({ code: "custom", message });
	});

export const CodexListAgentsResultSchema = z
	.object({
		agents: z.array(CodexListAgentSchema),
		observation: z.literal("unavailable").optional(),
		error: CodexListAvailabilityErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.agents.map((agent) => agent.agentId)).size !== value.agents.length) {
			ctx.addIssue({ code: "custom", message: "listed agent IDs must be unique" });
		}
		if ((value.observation === "unavailable") !== (value.error !== undefined)) {
			ctx.addIssue({ code: "custom", message: "unavailable list observation requires an error" });
		}
	});

const DaemonCommandBase = {
	type: z.literal("codex_command"),
	requestId: OperationIdSchema,
	ownerKey: CodexOwnerKeySchema,
	agentId: CodexAgentIdSchema,
};

export const CodexDaemonCommandSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...DaemonCommandBase,
			kind: z.literal("start"),
			operationId: OperationIdSchema,
			target: CodexExecutionTargetSchema,
			prompt: CodexPromptSchema,
		})
		.strict(),
	z
		.object({
			...DaemonCommandBase,
			kind: z.literal("message"),
			operationId: OperationIdSchema,
			target: CodexResolvedTargetSchema,
			threadId: OpaqueIdSchema,
			expectedTurnId: OpaqueIdSchema.optional(),
			prompt: CodexPromptSchema,
		})
		.strict(),
	z
		.object({
			...DaemonCommandBase,
			kind: z.literal("interrupt"),
			operationId: OperationIdSchema,
			target: CodexResolvedTargetSchema,
			threadId: OpaqueIdSchema,
			turnId: OpaqueIdSchema,
		})
		.strict(),
	z
		.object({
			...DaemonCommandBase,
			kind: z.literal("reconcile"),
			target: CodexResolvedTargetSchema,
			threadId: OpaqueIdSchema,
			turnId: OpaqueIdSchema.optional(),
		})
		.strict(),
]);

const DaemonEventBase = {
	type: z.literal("codex_event"),
	ownerKey: CodexOwnerKeySchema,
	daemonInstanceId: OpaqueIdSchema,
	targetId: OpaqueIdSchema,
	generation: z.number().int().nonnegative(),
	eventId: z.number().int().nonnegative(),
	agentId: CodexAgentIdSchema,
	threadId: OpaqueIdSchema,
};

export const CodexDaemonEventSchema = z.union([
	z
		.object({
			...DaemonEventBase,
			kind: z.literal("activity"),
			turnId: OpaqueIdSchema,
			itemId: OpaqueIdSchema,
			text: boundedUtf8(CODEX_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z
		.object({
			...DaemonEventBase,
			kind: z.literal("terminal"),
			turnId: OpaqueIdSchema,
			state: z.literal("completed"),
			finalItemId: OpaqueIdSchema.optional(),
			finalResponse: z.string(),
		})
		.strict(),
	z
		.object({
			...DaemonEventBase,
			kind: z.literal("terminal"),
			turnId: OpaqueIdSchema,
			state: z.literal("failed"),
			error: CodexErrorTextSchema,
		})
		.strict(),
	z
		.object({
			...DaemonEventBase,
			kind: z.literal("terminal"),
			turnId: OpaqueIdSchema,
			state: z.literal("interrupted"),
		})
		.strict(),
]);

const DaemonReceiptBase = {
	type: z.literal("codex_receipt"),
	requestId: OperationIdSchema,
	ownerKey: CodexOwnerKeySchema,
	daemonInstanceId: OpaqueIdSchema,
	eventId: z.number().int().nonnegative(),
	agentId: CodexAgentIdSchema,
};

const FencedDaemonReceiptBase = {
	...DaemonReceiptBase,
	targetId: OpaqueIdSchema,
	generation: z.number().int().nonnegative(),
};

export const CodexDaemonReceiptSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				...FencedDaemonReceiptBase,
				kind: z.literal("accepted"),
				operationId: OperationIdSchema,
				resolvedTarget: CodexResolvedTargetSchema,
				threadId: OpaqueIdSchema,
				turnId: OpaqueIdSchema,
				delivery: CodexDeliverySchema,
			})
			.strict(),
		z
			.object({
				...DaemonReceiptBase,
				kind: z.literal("rejected"),
				operationId: OperationIdSchema.optional(),
				error: CodexErrorTextSchema,
			})
			.strict(),
		z
			.object({
				...FencedDaemonReceiptBase,
				kind: z.literal("interruptResult"),
				operationId: OperationIdSchema,
				threadId: OpaqueIdSchema,
				turnId: OpaqueIdSchema,
				ok: z.literal(true),
			})
			.strict(),
		z
			.object({
				...FencedDaemonReceiptBase,
				kind: z.literal("interruptFailed"),
				operationId: OperationIdSchema,
				threadId: OpaqueIdSchema,
				turnId: OpaqueIdSchema,
				ok: z.literal(false),
				error: CodexErrorTextSchema,
			})
			.strict(),
		z
			.object({
				...FencedDaemonReceiptBase,
				kind: z.literal("reconciled"),
				resolvedTarget: CodexResolvedTargetSchema,
				threadId: OpaqueIdSchema,
				turnId: OpaqueIdSchema.optional(),
				turnState: CodexTurnStateSchema.optional(),
			})
			.strict(),
	])
	.superRefine((value, ctx) => {
		if ("resolvedTarget" in value && value.targetId !== value.resolvedTarget.targetId) {
			ctx.addIssue({ code: "custom", message: "receipt target fence does not match resolved target" });
		}
		if (value.kind === "reconciled" && value.turnState !== undefined && value.turnId === undefined) {
			ctx.addIssue({ code: "custom", message: "reconciled turn state requires a turn ID" });
		}
	});

/**
 * The gateway's cumulative commit point for one generation's reliable stream.
 *
 * Cumulative rather than per-event: a receipt only leaves the daemon's outbox once everything up to
 * it is durable, so one number retires a run of them and a lost ack costs a replay rather than a
 * gap. It is scoped to the generation that produced the ids, since a restarted App Server numbers
 * from zero again and an ack carried across would retire receipts nobody has seen.
 */
export const CodexEventAckSchema = z
	.object({
		type: z.literal("codex_ack"),
		daemonInstanceId: OpaqueIdSchema,
		targetId: OpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		throughEventId: z.number().int().nonnegative(),
	})
	.strict();

/**
 * What the daemon knows about its own App Servers, sent on each authenticated reconnect.
 *
 * The gateway, not the daemon, decides what needs reconciling: only the gateway knows which records
 * a session still believes are working. This says which supervisor and which generations are live so
 * the gateway can tell a survived child from a replaced one before it asks.
 */
export const CodexDaemonHelloSchema = z
	.object({
		type: z.literal("codex_hello"),
		daemonInstanceId: OpaqueIdSchema,
		targets: z.array(z.object({ targetId: OpaqueIdSchema, generation: z.number().int().nonnegative() }).strict()),
	})
	.strict();

export const CodexAppServerResponseSchema = z
	.looseObject({
		id: z.union([z.string(), z.number()]),
		result: z.unknown().optional(),
		error: z
			.looseObject({
				code: z.number(),
				message: z.string(),
			})
			.optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.result === undefined) === (value.error === undefined)) {
			ctx.addIssue({ code: "custom", message: "response requires exactly one of result or error" });
		}
	});

const CodexAppServerThreadIdentitySchema = z.looseObject({ id: OpaqueIdSchema });
export const CodexAppServerAgentMessageItemSchema = z.looseObject({
	type: z.literal("agentMessage"),
	id: OpaqueIdSchema,
	text: z.string(),
	phase: z.string().nullish(),
});
const CodexAppServerOtherItemSchema = z
	.looseObject({
		id: OpaqueIdSchema,
		type: z.string().min(1),
	})
	.refine((item) => item.type !== "agentMessage", "agent messages require text");
export const CodexAppServerThreadItemProjectionSchema = z.union([
	CodexAppServerAgentMessageItemSchema,
	CodexAppServerOtherItemSchema,
]);
const CodexAppServerTurnProjectionSchema = z.looseObject({
	id: OpaqueIdSchema,
	status: CodexTurnStateSchema,
	items: z.array(CodexAppServerThreadItemProjectionSchema),
});

export const CodexAppServerThreadStartResultSchema = z.looseObject({
	thread: CodexAppServerThreadIdentitySchema,
});
export const CodexAppServerThreadResumeResultSchema = z.looseObject({
	thread: CodexAppServerThreadIdentitySchema,
});
export const CodexAppServerThreadReadResultSchema = z.looseObject({
	thread: z.looseObject({
		id: OpaqueIdSchema,
		turns: z.array(CodexAppServerTurnProjectionSchema),
	}),
});
export const CodexAppServerTurnStartResultSchema = z.looseObject({
	turn: CodexAppServerTurnProjectionSchema.extend({ status: z.literal("inProgress") }),
});
export const CodexAppServerTurnSteerResultSchema = z.looseObject({ turnId: OpaqueIdSchema });
export const CodexAppServerEmptyResultSchema = z.looseObject({});

export const CodexAppServerAgentMessageCompletedSchema = z.looseObject({
	method: z.literal("item/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turnId: OpaqueIdSchema,
		item: CodexAppServerAgentMessageItemSchema,
	}),
});

export const CodexAppServerTurnCompletedSchema = z.looseObject({
	method: z.literal("turn/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turn: z.looseObject({
			id: OpaqueIdSchema,
			status: z.enum(["completed", "failed", "interrupted"]),
			error: z
				.looseObject({
					message: z.string(),
				})
				.nullish(),
		}),
	}),
});

export const CodexAppServerRequestSchema = z.looseObject({
	id: z.union([z.string(), z.number()]),
	method: z.string().min(1),
	params: z.unknown().optional(),
});

export type CodexAgentId = z.infer<typeof CodexAgentIdSchema>;
export type CodexAgentResult = z.infer<typeof CodexAgentResultSchema>;
export type CodexErrorCode = z.infer<typeof CodexErrorCodeSchema>;
export type CodexGatewayRequest = z.infer<typeof CodexGatewayRequestSchema>;
export type CodexExecutionTarget = z.infer<typeof CodexExecutionTargetSchema>;
export type CodexResolvedTarget = z.infer<typeof CodexResolvedTargetSchema>;
export type CodexStoredTurn = z.infer<typeof CodexStoredTurnSchema>;
export type CodexStoredActivity = z.infer<typeof CodexStoredActivitySchema>;
export type CodexStoredExchange = z.infer<typeof CodexStoredExchangeSchema>;
export type CodexStoredOperation = z.infer<typeof CodexStoredOperationSchema>;
export type CodexPersistedAgent = z.infer<typeof CodexPersistedAgentSchema>;
export type CodexAgentCatalog = z.infer<typeof CodexAgentCatalogSchema>;
export type CodexReconciliationFence = z.infer<typeof CodexReconciliationFenceSchema>;
export type CodexListAgent = z.infer<typeof CodexListAgentSchema>;
export type CodexListAgentsResult = z.infer<typeof CodexListAgentsResultSchema>;
export type CodexListAvailabilityError = z.infer<typeof CodexListAvailabilityErrorSchema>;
export type CodexDaemonCommand = z.infer<typeof CodexDaemonCommandSchema>;
export type CodexDaemonEvent = z.infer<typeof CodexDaemonEventSchema>;
export type CodexDaemonReceipt = z.infer<typeof CodexDaemonReceiptSchema>;
/**
 * Whether losing one daemon message would change what an owner believes about an outcome.
 *
 * Stated per kind rather than inferred, and keyed by the unions themselves so a new kind added above
 * without an entry here fails the build. It was inferred once, from "carries a generation", and that
 * read a fence's ORDERING role as a durability claim: commentary carries one too, and sat in the
 * daemon's outbox being replayed forever.
 */
export const CODEX_RELIABLE_EVENT_KIND: Record<CodexDaemonEvent["kind"], boolean> = {
	activity: false,
	terminal: true,
};
export const CODEX_RELIABLE_RECEIPT_KIND: Record<CodexDaemonReceipt["kind"], boolean> = {
	accepted: true,
	rejected: false,
	interruptResult: true,
	interruptFailed: true,
	reconciled: true,
};

export function isReliableCodexMessage(message: CodexDaemonEvent | CodexDaemonReceipt): boolean {
	return message.type === "codex_event"
		? CODEX_RELIABLE_EVENT_KIND[message.kind]
		: CODEX_RELIABLE_RECEIPT_KIND[message.kind];
}

export type CodexEventAck = z.infer<typeof CodexEventAckSchema>;
export type CodexDaemonHello = z.infer<typeof CodexDaemonHelloSchema>;

function migrateCodexAgentRecoveryIntent(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const agent = raw as Record<string, unknown>;
	if (!Array.isArray(agent.operations)) return raw;
	const threadId = typeof agent.threadId === "string" ? agent.threadId : undefined;
	const agentFence = CodexReconciliationFenceSchema.safeParse(agent.fence);
	let hasUnverifiedAcceptance = false;
	const operations = agent.operations.map((candidate) => {
		if (!candidate || typeof candidate !== "object") return candidate;
		const operation = candidate as Record<string, unknown>;
		let migrated = operation;
		if (operation.preDispatch === undefined) {
			switch (operation.kind) {
				case "start":
					migrated = { ...operation, preDispatch: { agentState: "creating" } };
					break;
				case "message": {
					const turnId = typeof operation.expectedTurnId === "string" ? operation.expectedTurnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
				case "stop": {
					const turnId = typeof operation.turnId === "string" ? operation.turnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
			}
		}
		if (
			migrated.kind !== "start" &&
			migrated.preDispatch &&
			typeof migrated.preDispatch === "object" &&
			!("fence" in migrated.preDispatch) &&
			agentFence.success
		) {
			migrated = {
				...migrated,
				preDispatch: { ...(migrated.preDispatch as Record<string, unknown>), fence: agentFence.data },
			};
		}
		if (
			(migrated.kind === "start" || migrated.kind === "message") &&
			migrated.state === "accepted" &&
			migrated.acceptanceFence === undefined &&
			migrated.acceptanceUnverified === undefined
		) {
			hasUnverifiedAcceptance = true;
			migrated = { ...migrated, acceptanceUnverified: true };
		}
		if (migrated.acceptanceUnverified === true) hasUnverifiedAcceptance = true;
		return migrated;
	});
	return {
		...agent,
		agentState: hasUnverifiedAcceptance ? "recovering" : agent.agentState,
		operations,
	};
}

/** Restore a session-owned catalog without sacrificing its owner to one damaged agent entry. */
export function restoreCodexAgentCatalog(raw: unknown): CodexAgentCatalog | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const envelope = raw as { version?: unknown; revision?: unknown; agents?: unknown };
	if (
		envelope.version !== 1 ||
		typeof envelope.revision !== "number" ||
		!Number.isInteger(envelope.revision) ||
		envelope.revision < 0 ||
		!Array.isArray(envelope.agents)
	)
		return undefined;

	const parsed = envelope.agents.flatMap((candidate) => {
		const result = CodexPersistedAgentSchema.safeParse(migrateCodexAgentRecoveryIntent(candidate));
		return result.success ? [result.data] : [];
	});
	const agentIdCounts = new Map<string, number>();
	const operationIdCounts = new Map<string, number>();
	for (const agent of parsed) {
		agentIdCounts.set(agent.agentId, (agentIdCounts.get(agent.agentId) ?? 0) + 1);
		for (const operation of agent.operations) {
			operationIdCounts.set(operation.operationId, (operationIdCounts.get(operation.operationId) ?? 0) + 1);
		}
	}
	const agents = parsed.filter(
		(agent) =>
			agentIdCounts.get(agent.agentId) === 1 &&
			agent.operations.every((operation) => operationIdCounts.get(operation.operationId) === 1),
	);
	const catalog = CodexAgentCatalogSchema.safeParse({ version: 1, revision: envelope.revision, agents });
	return catalog.success ? catalog.data : undefined;
}

/** Builds the complete caller-visible history by explicitly copying only public fields. */
export function projectCodexListAgent(agent: CodexPersistedAgent): CodexListAgent {
	const stored = CodexPersistedAgentSchema.parse(agent);
	const exchanges = stored.exchanges.map((exchange) => ({
		kind: exchange.kind,
		prompt: exchange.prompt,
		status: exchange.status,
		delivery: exchange.delivery,
		turnId: exchange.turnId,
		createdAt: exchange.createdAt,
		acceptedAt: exchange.acceptedAt,
	}));
	const turns = stored.turns.map((turn) => {
		const base = {
			id: turn.id,
			state: turn.state,
			activities: turn.activities.map((activity) =>
				activity.kind === "commentary"
					? { kind: activity.kind, text: activity.text }
					: { kind: activity.kind, omitted: activity.omitted },
			),
			updatedAt: turn.updatedAt,
		};
		switch (turn.state) {
			case "completed":
				return { ...base, state: turn.state, finalResponse: turn.finalResponse };
			case "failed":
				return { ...base, state: turn.state, error: turn.error };
			case "inProgress":
			case "interrupted":
				return { ...base, state: turn.state };
			default:
				throw new Error("unsupported Codex turn state");
		}
	});
	return CodexListAgentSchema.parse({
		agentId: stored.agentId,
		agentState: stored.agentState,
		activeTurnId: stored.activeTurnId,
		exchanges,
		turns,
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
	});
}

export function projectCodexListResult(
	agents: readonly CodexPersistedAgent[],
	error?: CodexListAvailabilityError,
): CodexListAgentsResult {
	return CodexListAgentsResultSchema.parse({
		agents: agents.map(projectCodexListAgent),
		observation: error ? "unavailable" : undefined,
		error,
	});
}
