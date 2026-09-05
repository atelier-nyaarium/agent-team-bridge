// Copilot delegation: the agent/turn/observation vocabulary, the validated per-call result shape a
// tool answers with, and the five tools' own input and gateway-request envelopes.

import { z } from "zod";
import { CopilotActivitiesSchema } from "./copilotAgentActivities.js";
import {
	CopilotAgentIdSchema,
	CopilotErrorTextSchema,
	CopilotOpaqueIdSchema,
	CopilotOperationIdSchema,
	CopilotPromptSchema,
} from "./copilotAgentIdentity.js";

////////////////////////////////
//  Enums and errors

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
//  Agent result

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

////////////////////////////////
//  Tool inputs and gateway request

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

export type CopilotAgentResult = z.infer<typeof CopilotAgentResultSchema>;
export type CopilotDaemonFailureCode = z.infer<typeof CopilotDaemonFailureCodeSchema>;
export type CopilotErrorCode = z.infer<typeof CopilotErrorCodeSchema>;
export type CopilotGatewayRequest = z.infer<typeof CopilotGatewayRequestSchema>;
