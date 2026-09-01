// Codex delegation: the gateway-daemon wire, not the App Server's own protocol. Commands go down,
// events and receipts come back fenced by (daemonInstanceId, targetId, generation, lastEventId) so
// which child spoke and how far in is always recoverable; the ack retires the daemon's reliable
// outbox and the hello re-establishes fences on reconnect. `CodexReconciliationFenceSchema` lives
// here because it is this relay's own ordering primitive, reused by the persisted-agent domain to
// record what an operation last saw.

import { z } from "zod";
import {
	boundedUtf8,
	CODEX_ACTIVITY_MAX_BYTES,
	CodexAgentIdSchema,
	CodexErrorTextSchema,
	CodexOwnerKeySchema,
	CodexPromptSchema,
	CodexServiceTierSchema,
	OpaqueIdSchema,
	OperationIdSchema,
} from "./codexAgentIdentity.js";
import { CodexDeliverySchema, CodexTurnStateSchema } from "./codexAgentState.js";
import { CodexExecutionTargetSchema, CodexResolvedTargetSchema } from "./codexAgentTargets.js";

export const CodexReconciliationFenceSchema = z
	.object({
		daemonInstanceId: OpaqueIdSchema,
		targetId: OpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		lastEventId: z.number().int().nonnegative(),
	})
	.strict();

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
			model: z.string().min(1).max(128).optional(),
			serviceTier: CodexServiceTierSchema.optional(),
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
			/** The tier the gateway remembers, so a resumed thread keeps the pace it was set to. */
			serviceTier: CodexServiceTierSchema.optional(),
			/** The thread's model, carried only for the tier check. A restarted daemon never saw the
			 * start that chose it. */
			model: z.string().min(1).max(128).optional(),
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

export type CodexReconciliationFence = z.infer<typeof CodexReconciliationFenceSchema>;
export type CodexDaemonCommand = z.infer<typeof CodexDaemonCommandSchema>;
export type CodexDaemonEvent = z.infer<typeof CodexDaemonEventSchema>;
export type CodexDaemonReceipt = z.infer<typeof CodexDaemonReceiptSchema>;
/**
 * Whether losing one daemon message would change what an owner believes about an outcome.
 *
 * Stated per kind rather than inferred, and keyed by the unions themselves so a new kind added above
 * without an entry here fails the build. A fence's ORDERING role is not a durability claim: inferring
 * reliability from "carries a generation" would mark commentary reliable too, and an item classified
 * that way but never acknowledged sits in the daemon's outbox being replayed forever.
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
