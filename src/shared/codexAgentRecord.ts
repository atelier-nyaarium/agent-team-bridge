// Codex delegation: one agent's durable history - its turns, the exchanges (start/message calls)
// that produced them, the operations that delivered those exchanges, and the persisted agent record
// that ties them together under the cross-boundary invariants `codexAgentHistoryIssues` states once
// for both this private shape and the public projection in codexAgentCatalog.ts.

import { z } from "zod";
import { agentTurnHistoryIssues } from "./agent-record.js";
import { CodexStoredActivitiesSchema } from "./codexAgentActivities.js";
import {
	CodexAgentIdSchema,
	CodexErrorTextSchema,
	CodexPromptSchema,
	codexOperationFingerprint,
	OpaqueIdSchema,
	OperationIdSchema,
} from "./codexAgentIdentity.js";
import { CodexReconciliationFenceSchema } from "./codexAgentRelay.js";
import { CodexAgentStateSchema, CodexDeliverySchema, type CodexTurnStateSchema } from "./codexAgentState.js";
import { CodexExecutionTargetSchema, CodexResolvedTargetSchema } from "./codexAgentTargets.js";

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

/** Cross-boundary history invariants shared by the private catalog and its public projection. The
 * turn-level subset lives in `agentTurnHistoryIssues`, shared with the Copilot family; everything
 * exchange-shaped is Codex-only and stays here. */
export function codexAgentHistoryIssues(value: CodexAgentHistoryView): string[] {
	const issues: string[] = [...agentTurnHistoryIssues(value)];

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

export type CodexStoredTurn = z.infer<typeof CodexStoredTurnSchema>;
export type CodexStoredExchange = z.infer<typeof CodexStoredExchangeSchema>;
export type CodexStoredOperation = z.infer<typeof CodexStoredOperationSchema>;
export type CodexPersistedAgent = z.infer<typeof CodexPersistedAgentSchema>;
