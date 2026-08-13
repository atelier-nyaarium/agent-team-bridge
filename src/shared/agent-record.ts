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
