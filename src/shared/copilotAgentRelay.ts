import { z } from "zod";
import {
	boundedUtf8,
	COPILOT_ACTIVITY_MAX_BYTES,
	CopilotAgentIdSchema,
	CopilotErrorTextSchema,
	CopilotOpaqueIdSchema,
	CopilotOperationIdSchema,
	CopilotOwnerKeySchema,
	CopilotPromptSchema,
} from "./copilotAgentIdentity.js";
import { CopilotDaemonFailureCodeSchema, CopilotDeliverySchema } from "./copilotAgentState.js";
import { CopilotExecutionTargetSchema, CopilotResolvedTargetSchema } from "./copilotAgentTargets.js";

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

export type CopilotDaemonCommand = z.infer<typeof CopilotDaemonCommandSchema>;
export type CopilotDaemonEvent = z.infer<typeof CopilotDaemonEventSchema>;
export type CopilotDaemonReceipt = z.infer<typeof CopilotDaemonReceiptSchema>;
export type CopilotDaemonHello = z.infer<typeof CopilotDaemonHelloSchema>;
export type CopilotEventAck = z.infer<typeof CopilotEventAckSchema>;

// Keyed by the event union so new kinds require an explicit policy.
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
