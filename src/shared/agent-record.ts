// Shared primitives and invariant bodies for the per-backend agent record families. Each backend
// keeps its own zod objects and calls these from its own refines, so a rule omitted in a
// transcription is a missing call the tests see, not silently absent behavior. Messages are the
// Codex family's originals; both backends report them verbatim.

import crypto from "node:crypto";
import { z } from "zod";
import type { AgentBackendId } from "./agent-backend.js";

////////////////////////////////
//  Bounds

export const AGENT_PROMPT_MAX_BYTES = 256 * 1024;
export const AGENT_ACTIVITY_MAX_BYTES = 16 * 1024;
export const AGENT_ACTIVITY_MAX_ITEMS = 32;
export const AGENT_ERROR_MAX_BYTES = 16 * 1024;

////////////////////////////////
//  Interfaces & Types

export interface AgentActivityView {
	kind: "commentary" | "truncated";
	itemId?: string;
}

export interface AgentTurnHistoryView {
	agentState: string;
	activeTurnId?: string;
	turns: ReadonlyArray<{ id: string; state: string; updatedAt: number }>;
	createdAt: number;
	updatedAt: number;
}

/** The stored narration shape both backends declare. Structurally identical on purpose: their zod
 * objects stay their own (the byte caps and id grammars differ), but anything that REASONS about
 * activities reasons about this. */
export type AgentStoredActivity =
	| { kind: "commentary"; itemId: string; text: string }
	| { kind: "truncated"; omitted: number };

/** One operation as replay identifies it. Every field a replay decision may read is here, so a
 * backend cannot quietly omit a term the other one weighs. */
export interface AgentReplayOperation {
	operationId: string;
	fingerprint: string;
	state: string;
	/** Codex's Phase 2 flag: accepted, but the acceptance was never fenced. Copilot has no such
	 * concept and passes nothing, which DECLARES the difference where omitting the term hid it. */
	acceptanceUnverified?: boolean;
}

export interface AgentReplayHolder<Operation extends AgentReplayOperation> {
	operations: readonly Operation[];
}

/** What a replay lookup found. `conflict` carries its own reason so each backend can throw its own
 * error type without restating the rule that produced it. */
export type AgentReplayOutcome<Agent, Operation> =
	| { kind: "none" }
	| { kind: "conflict"; reason: string }
	| { kind: "match"; agent: Agent; operation: Operation; replayable: boolean };

////////////////////////////////
//  Functions & Helpers

export function boundedUtf8(maxBytes: number, name: string) {
	return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
		message: `${name} must be at most ${maxBytes} UTF-8 bytes`,
	});
}

/** Strip control characters, collapse whitespace, and cut to the byte budget on a character edge. */
export function sanitizeAgentErrorText(raw: string, maxBytes: number): string {
	const normalized = raw
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (new TextEncoder().encode(normalized).byteLength <= maxBytes) return normalized;

	let result = "";
	let bytes = 0;
	for (const character of normalized) {
		const characterBytes = new TextEncoder().encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result.trimEnd();
}

/**
 * The agent ID a start operation will use, derived from the operation ID rather than minted fresh.
 * That is what makes a start retry idempotent: the same invocation always names the same agent,
 * however many times its HTTP call is retried. The domain tag reproduces each backend's historical
 * literal (`CODEX_AGENT_V1`, `COPILOT_AGENT_V1`), so persisted IDs stay stable.
 */
export function agentIdForOperation(backendId: AgentBackendId, operationId: string): string {
	const digest = crypto
		.createHash("sha256")
		.update(`${backendId.toUpperCase()}_AGENT_V1\n${operationId}`)
		.digest("hex");
	return `${backendId}_${digest.slice(0, 32)}`;
}

export function agentOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify([kind, agentId, prompt ?? null]))
		.digest("hex");
}

/** The array-level truncation-marker invariant, plus itemId uniqueness for stored shapes. A
 * caller-visible activity carries no itemId, so the uniqueness rule is vacuous there. */
export function agentActivityIssues(activities: ReadonlyArray<AgentActivityView>, maxItems: number): string[] {
	const issues: string[] = [];
	const commentary = activities.filter((activity) => activity.kind === "commentary");
	const markerIndexes = activities.flatMap((activity, index) => (activity.kind === "truncated" ? [index] : []));
	if (commentary.length > maxItems) issues.push("too many commentary activities");
	const withItemIds = commentary.flatMap((activity) => (activity.itemId === undefined ? [] : [activity.itemId]));
	if (new Set(withItemIds).size !== withItemIds.length) issues.push("stored activity item IDs must be unique");
	if (markerIndexes.length > 1 || (markerIndexes.length === 1 && markerIndexes[0] !== activities.length - 1)) {
		issues.push("the truncation marker must appear once at the end");
	}
	if (markerIndexes.length === 1 && commentary.length !== maxItems) {
		issues.push("truncation requires a full retained activity window");
	}
	return issues;
}

/**
 * The turn's activities with one more commentary item folded in, or null when it is already held.
 *
 * The retained window is the FIRST items rather than the most recent: a turn's opening commentary is
 * what explains what it decided to do, and a late item can always be read from the final response.
 *
 * The SOLE producer of a stored activity array. `agentActivityIssues` validates the shape this
 * builds, and the two lived apart while each backend wrote its own builder - one of them against a
 * hardcoded 32 rather than the shared bound, so raising the bound would have moved one and not the
 * other. `agent-replay.test.ts` fails the build on a second builder.
 */
export function appendAgentActivity(
	existing: readonly AgentStoredActivity[],
	itemId: string,
	text: string,
	maxItems: number,
): AgentStoredActivity[] | null {
	const commentary = existing.filter((activity) => activity.kind === "commentary");
	if (commentary.some((activity) => activity.itemId === itemId)) return null;
	if (commentary.length < maxItems) return [...commentary, { kind: "commentary", itemId, text }];
	const omitted = existing.find((activity) => activity.kind === "truncated")?.omitted ?? 0;
	return [...commentary, { kind: "truncated", omitted: omitted + 1 }];
}

/**
 * Whether an operation already on record may be reported as a completed replay.
 *
 * An HTTP retry must never re-dispatch, so the question is only ever "what do I tell the caller
 * about the operation I already hold". Three terms, and dropping any one of them was a shipped
 * divergence:
 *
 * - Only an ACCEPTED operation replays. One still `requested` was never confirmed by a daemon, and
 *   one marked `indeterminate` is the gateway's own record of "I could not find out" - reporting
 *   either as a completed replay tells the caller a thing the gateway does not know.
 * - An acceptance that was never fenced does not replay (Codex only; see AgentReplayOperation).
 * - The catalog must be confirmed durable, and `ensureDurable` is expected to REPAIR rather than
 *   merely report: a retry is evidence the operation matters, so flushing an unconfirmed catalog
 *   costs one fsync at exactly the moment it is worth paying. It runs last, so an operation that
 *   was never replayable does not buy a write.
 */
export function agentOperationReplayable(operation: AgentReplayOperation, ensureDurable: () => boolean): boolean {
	if (operation.state !== "accepted") return false;
	if (operation.acceptanceUnverified) return false;
	return ensureDurable();
}

/**
 * Find the one operation a retried operation ID names, across every agent in a catalog.
 *
 * TWO claimants is a conflict rather than a first-match, and so is a fingerprint that does not
 * match. Both mean the same thing to a caller - this operation ID was reused with different input -
 * and neither may be resolved by picking one, since nothing distinguishes the copies. Reachable
 * today only through a mutation bug or an injected catalog, which is exactly why one backend having
 * the check and the other not went unnoticed.
 */
export function resolveAgentReplay<Agent extends AgentReplayHolder<AgentReplayOperation>>(
	agents: readonly Agent[],
	operationId: string,
	fingerprint: string,
	ensureDurable: () => boolean,
): AgentReplayOutcome<Agent, Agent["operations"][number]> {
	const matches = agents.flatMap((agent) =>
		agent.operations.flatMap((operation) => (operation.operationId === operationId ? [{ agent, operation }] : [])),
	);
	if (matches.length === 0) return { kind: "none" };
	if (matches.length > 1) return { kind: "conflict", reason: "operation ID was reused with different input" };
	const { agent, operation } = matches[0]!;
	if (operation.fingerprint !== fingerprint)
		return { kind: "conflict", reason: "operation ID was reused with different input" };
	return { kind: "match", agent, operation, replayable: agentOperationReplayable(operation, ensureDurable) };
}

/** The turn-level invariants both record families share. Backend-specific rules (exchanges, fences,
 * sessions) stay in each family's own refine. */
export function agentTurnHistoryIssues(view: AgentTurnHistoryView): string[] {
	const issues: string[] = [];
	if (view.updatedAt < view.createdAt) issues.push("agent update cannot predate creation");

	const activeTurns = view.activeTurnId ? view.turns.filter((turn) => turn.id === view.activeTurnId) : [];
	const inProgressTurns = view.turns.filter((turn) => turn.state === "inProgress");
	if (
		view.activeTurnId &&
		(activeTurns.length !== 1 || activeTurns[0]?.state !== "inProgress" || inProgressTurns.length !== 1)
	) {
		issues.push("active turn must resolve to one in-progress turn");
	}
	if (!view.activeTurnId && inProgressTurns.length > 0) {
		issues.push("an in-progress turn must be the active turn");
	}
	if (view.agentState === "working" && !view.activeTurnId) issues.push("working agent requires an active turn");
	if (view.agentState === "idle" && view.activeTurnId) issues.push("idle agent cannot retain an active turn");
	if (new Set(view.turns.map((turn) => turn.id)).size !== view.turns.length) {
		issues.push("turn IDs must be unique");
	}
	for (const turn of view.turns) {
		if (turn.updatedAt < view.createdAt || turn.updatedAt > view.updatedAt) {
			issues.push("turn timestamp is outside its agent lifetime");
		}
	}
	return issues;
}

/**
 * Restore a session-owned catalog without sacrificing its owner to one damaged agent entry.
 *
 * `parseAgent` owns per-entry validation (and any migration); an entry it rejects is dropped alone.
 * Cross-entry identity is enforced here: a duplicated agent or operation ID drops every claimant,
 * since neither copy can be told from the other.
 */
export function restoreAgentCatalog<
	Agent extends { agentId: string; operations: ReadonlyArray<{ operationId: string }> },
>(
	raw: unknown,
	parseAgent: (candidate: unknown) => Agent | undefined,
): { version: 1; revision: number; agents: Agent[] } | undefined {
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
		const agent = parseAgent(candidate);
		return agent === undefined ? [] : [agent];
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
	return { version: 1, revision: envelope.revision, agents };
}
