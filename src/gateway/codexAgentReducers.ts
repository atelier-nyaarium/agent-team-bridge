import {
	CODEX_ACTIVITY_MAX_ITEMS,
	type CodexPersistedAgent,
	type CodexReconciliationFence,
	type CodexResolvedTarget,
	type CodexStoredActivity,
	type CodexStoredOperation,
} from "../shared/codex-thinking.js";
import { type CodexApplication, CodexTransitionError } from "./codexAgentTypes.js";

////////////////////////////////
//  Functions & Helpers

export function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0) {
		throw new CodexTransitionError("invalid_input", "transition timestamp must be a nonnegative integer");
	}
	return at;
}

export function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}

export function sameTarget(left: CodexResolvedTarget | undefined, right: CodexResolvedTarget): boolean {
	return left?.kind === right.kind && left.targetId === right.targetId && left.cwd === right.cwd;
}

export function sameFence(
	left: CodexReconciliationFence | undefined,
	right: CodexReconciliationFence | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.daemonInstanceId === right.daemonInstanceId &&
		left.targetId === right.targetId &&
		left.generation === right.generation &&
		left.lastEventId === right.lastEventId
	);
}

export function advancesFence(current: CodexReconciliationFence | undefined, next: CodexReconciliationFence): boolean {
	return (
		!current ||
		(current.daemonInstanceId === next.daemonInstanceId &&
			current.targetId === next.targetId &&
			current.generation === next.generation &&
			next.lastEventId > current.lastEventId)
	);
}

/** Only a REQUESTED delivery blocks the next one. An indeterminate one is already settled as far as
 * this gateway is concerned, and counting it would wedge the agent permanently: nothing ever
 * transitions an indeterminate operation, so a single unprovable delivery would refuse every
 * follow-up for the agent's whole life. Reconciliation, not this guard, is what restores truth. */
export function hasPendingPrompt(agent: CodexPersistedAgent): boolean {
	return agent.operations.some(
		(operation) => (operation.kind === "start" || operation.kind === "message") && operation.state === "requested",
	);
}

/**
 * Where a daemon-supplied fence sits relative to the one an agent already holds.
 *
 * `foreign` is the case that must not be treated as noise: a different supervisor or generation
 * means the child that produced this event is not the one the record was fenced against, so nothing
 * can be applied and nothing may be acknowledged until reconciliation re-establishes which child is
 * speaking. Acknowledging it would retire an event the gateway never took.
 */
export function classifyFence(
	current: CodexReconciliationFence | undefined,
	next: CodexReconciliationFence,
): "advances" | "duplicate" | "foreign" {
	if (!current) return "foreign";
	if (current.daemonInstanceId !== next.daemonInstanceId || current.targetId !== next.targetId) return "foreign";
	if (current.generation !== next.generation) return "foreign";
	return next.lastEventId > current.lastEventId ? "advances" : "duplicate";
}

/** The frame does not describe anything this gateway owns, and never will. Safe to retire. */
export function ignore(reason: string): CodexApplication {
	return { disposition: "ignored", reason };
}

/** The frame is fine; building a record from it failed. Never retired, because the failure is this
 * gateway's and a retry or a reconcile may still place it. */
export function failed(reason: string): CodexApplication {
	return { disposition: "failed", reason };
}

/** The fence a fenced daemon message stands at. Its own event ID is the fence's high-water mark, so
 * a receipt and the events around it order against one another by construction. */
export function fenceOf(message: {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	eventId: number;
}): CodexReconciliationFence {
	return {
		daemonInstanceId: message.daemonInstanceId,
		targetId: message.targetId,
		generation: message.generation,
		lastEventId: message.eventId,
	};
}

/**
 * The turn's activities with one more commentary item folded in, or null when it is already held.
 *
 * The retained window is the FIRST items rather than the most recent: a turn's opening commentary is
 * what explains what it decided to do, and a late item can always be read from the final response.
 */
export function appendActivity(
	existing: readonly CodexStoredActivity[],
	itemId: string,
	text: string,
): CodexStoredActivity[] | null {
	const commentary = existing.filter((activity) => activity.kind === "commentary");
	if (commentary.some((activity) => activity.itemId === itemId)) return null;
	if (commentary.length < CODEX_ACTIVITY_MAX_ITEMS) return [...commentary, { kind: "commentary", itemId, text }];
	const omitted = existing.find((activity) => activity.kind === "truncated")?.omitted ?? 0;
	return [...commentary, { kind: "truncated", omitted: omitted + 1 }];
}

/** Clear the recovery flag Phase 2 sets on a delivery whose acceptance was never fenced. A
 * reconciled agent has a live fence again, which is exactly what the flag stood in for. */
export function refenceUnverified(
	operations: readonly CodexStoredOperation[],
	fence: CodexReconciliationFence,
): CodexStoredOperation[] {
	return operations.map((operation) =>
		operation.acceptanceUnverified
			? { ...operation, acceptanceUnverified: undefined, acceptanceFence: fence }
			: operation,
	);
}
