// Codex delegation: the agent/turn/observation vocabulary, the validated per-call result shape a
// tool answers with, and the five tools' own input and gateway-request envelopes.

import { z } from "zod";
import { CodexActivitiesSchema } from "./codexAgentActivities.js";
import {
	CodexAgentIdSchema,
	CodexErrorTextSchema,
	CodexPromptSchema,
	CodexServiceTierSchema,
	OpaqueIdSchema,
	OperationIdSchema,
} from "./codexAgentIdentity.js";

////////////////////////////////
//  Enums and errors

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
	"agent_dead",
	"agent_unreachable",
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
export const CodexListAvailabilityErrorSchema = CodexErrorSchema.extend({
	code: z.enum(["daemon_unavailable", "app_server_unavailable", "protocol_incompatible", "protocol_error"]),
}).strict();

////////////////////////////////
//  Agent result

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
				value.error?.code === "agent_dead" ||
				value.error?.code === "agent_unreachable" ||
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
			if (value.error?.code === "agent_dead" && (value.agentState !== "unavailable" || value.error.retryable)) {
				ctx.addIssue({
					code: "custom",
					message: "agent_dead requires an unavailable agent and is never retryable",
					path: ["error"],
				});
			}
			if (
				value.error?.code === "agent_unreachable" &&
				(value.agentState !== "recovering" || !value.error.retryable)
			) {
				ctx.addIssue({
					code: "custom",
					message: "agent_unreachable requires a recovering agent and is retryable",
					path: ["error"],
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

////////////////////////////////
//  Tool inputs and gateway request

export const CodexStartAgentInputSchema = z
	.object({
		prompt: CodexPromptSchema,
		/** Belongs on start alone: a model is fixed for a thread's life. Verified against the App
		 * Server's own `model/list` at the point of use, so an unoffered one is refused rather than
		 * quietly falling back to a tier nobody asked for. */
		model: z.string().min(1).max(128).optional(),
		/** Host-only, and on start alone: a thread's working directory is fixed for its life. Resolved
		 * by the daemon's `resolveHostWorkdir`, which falls back to home rather than trusting a path. */
		cwd: z.string().min(1).max(512).optional(),
		/** Unlike a model, a tier holds until changed rather than for the thread's life. */
		serviceTier: CodexServiceTierSchema.optional(),
	})
	.strict();

export const CodexMessageAgentInputSchema = z
	.object({
		agentId: CodexAgentIdSchema,
		prompt: CodexPromptSchema,
		/** Changes the agent's tier from here on. `turn/steer` carries no tier, so a change asked for
		 * while a turn runs lands on the next one. */
		serviceTier: CodexServiceTierSchema.optional(),
	})
	.strict();

export const CodexAwaitAgentInputSchema = z.object({ agentId: CodexAgentIdSchema }).strict();
export const CodexStopAgentInputSchema = z.object({ agentId: CodexAgentIdSchema }).strict();
export const CodexListAgentsInputSchema = z
	.object({
		agentId: CodexAgentIdSchema.optional(),
		detail: z.enum(["summary", "full"]).optional(),
		limit: z.number().int().positive().max(50).optional(),
	})
	.strict();

export const CodexGatewayRequestSchema = z.discriminatedUnion("kind", [
	CodexStartAgentInputSchema.extend({ kind: z.literal("start"), operationId: OperationIdSchema }).strict(),
	CodexMessageAgentInputSchema.extend({ kind: z.literal("message"), operationId: OperationIdSchema }).strict(),
	CodexAwaitAgentInputSchema.extend({ kind: z.literal("await") }).strict(),
	CodexStopAgentInputSchema.extend({ kind: z.literal("stop"), operationId: OperationIdSchema }).strict(),
	CodexListAgentsInputSchema.extend({ kind: z.literal("list") }).strict(),
]);

export type CodexAgentResult = z.infer<typeof CodexAgentResultSchema>;
export type CodexErrorCode = z.infer<typeof CodexErrorCodeSchema>;
export type CodexGatewayRequest = z.infer<typeof CodexGatewayRequestSchema>;
export type CodexListAvailabilityError = z.infer<typeof CodexListAvailabilityErrorSchema>;
