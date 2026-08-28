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

/**
 * Everything that identifies one operation, so no call site decides for itself what goes in.
 *
 * The model belongs here because a thread's model is fixed for its whole life and is verified
 * against the backend's own offered list at the point of use, so it is part of WHAT WAS ASKED FOR
 * rather than a detail of how the request was dispatched. Codex omitted it and Copilot included it,
 * which meant the same retry with a changed model replayed silently on one backend and raised a
 * conflict on the other.
 */
export interface AgentOperationIdentity {
	kind: "start" | "message" | "stop";
	agentId: string;
	prompt?: string;
	/** Start only; a model is fixed for a thread's life, so no other kind carries one. */
	model?: string;
	/**
	 * How this record family spelled a MODEL-LESS start before the model was persisted. A fact about
	 * what is already on disk, not a policy, which is why declaring it does not reintroduce the
	 * divergence this exists to remove.
	 *
	 * Only Copilot needs one. It always appended a separator and the model, so a model-less start was
	 * `prompt + "\n"` where the encoding below now writes `prompt`. Codex needs NO tolerance at all,
	 * because it never wrote a model term and the encoding below reproduces its spelling exactly.
	 *
	 * That asymmetry is the whole reason the encoding is shaped this way. Folding the model in
	 * unconditionally would have made every model-less start differ from its Codex legacy, forcing a
	 * tolerance that PERMANENTLY accepted two spellings for the commonest record there is - which is
	 * a tamper check quietly weakened forever rather than a migration that ends.
	 */
	legacyModellessStart?: "trailing-separator";
}

/** Whether a stored fingerprint can be recomputed, and whether it agreed.
 *
 * Three-valued because one legacy shape genuinely cannot be checked: a Copilot start written before
 * the model was persisted folded the model INTO its fingerprint without storing it, so there is
 * nothing left to recompute from. Reporting that as a mismatch would drop the agent; reporting it as
 * a match would claim a check that did not happen. */
export type AgentFingerprintVerdict = "match" | "mismatch" | "unverifiable";

/**
 * The one encoding. Message carries its prompt, stop carries neither, and start folds in the model
 * ONLY when one was named.
 *
 * That condition is load-bearing rather than tidy. A model-less start is by far the commonest record,
 * and this spelling is byte-identical to what Codex has always written, so those records need no
 * tolerance and keep a tamper check at full strength forever. Appending an empty model term instead
 * would have made every one of them differ from its own history, and the tolerance that bought back
 * would have accepted two spellings for the commonest record permanently.
 */
export function agentOperationFingerprintOf(identity: AgentOperationIdentity): string {
	if (identity.kind === "start") {
		const input = identity.model === undefined ? identity.prompt : `${identity.prompt ?? ""}\n${identity.model}`;
		return agentOperationFingerprint("start", identity.agentId, input);
	}
	if (identity.kind === "message") return agentOperationFingerprint("message", identity.agentId, identity.prompt);
	return agentOperationFingerprint("stop", identity.agentId);
}

/**
 * Check a stored fingerprint against what the record now says identifies it.
 *
 * The SOLE verifier, so a backend cannot hold the encoding without the check or the check without
 * the encoding - which is exactly how these two shipped: Codex recomputed a fingerprint that was
 * missing the model, Copilot computed one WITH the model and never recomputed it at all.
 *
 * Legacy tolerance rather than a schema version bump. A version bump with no migration drops every
 * pre-existing agent individually on restore, and this record family is restored per entry, so that
 * loss would be silent and permanent. The tolerance is self-limiting: it applies only where no model
 * is persisted, which stops being true for everything written from here on.
 */
export function agentFingerprintVerdict(stored: string, identity: AgentOperationIdentity): AgentFingerprintVerdict {
	if (stored === agentOperationFingerprintOf(identity)) return "match";
	// Nothing below is about a start, and nothing below applies once a model is known: a caller that
	// names one either matched above or is naming a different one.
	if (identity.kind !== "start" || identity.model !== undefined) return "mismatch";
	if (identity.legacyModellessStart !== "trailing-separator") return "mismatch";
	// The family that always appended a separator. A model-less legacy record recomputes EXACTLY
	// here, so a tampered one is still caught.
	if (stored === agentOperationFingerprint("start", identity.agentId, `${identity.prompt ?? ""}\n`)) return "match";
	// Neither spelling, and this family folded a model in without storing it, so a legacy start that
	// named one left nothing to recompute from. Not a mismatch: that would drop the agent.
	return "unverifiable";
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
 * A turn's stored activities in the shape a CALLER sees: the same items with `itemId` dropped.
 *
 * That id is the daemon's dedup key and means nothing outside the gateway, so publishing it would
 * leak an internal handle into an answer. Both routes wrote this projection out by hand, identically,
 * which is the shape issue #271 already shipped once: a published projection drifting from its
 * sibling while every test kept passing.
 *
 * Takes the array rather than a turn, because the two backends' turn types differ in everything else.
 */
export function publishedActivities(
	stored: readonly AgentStoredActivity[] | undefined,
): Array<{ kind: "commentary"; text: string } | { kind: "truncated"; omitted: number }> {
	return (stored ?? []).map((activity) =>
		activity.kind === "commentary" ? { kind: activity.kind, text: activity.text } : activity,
	);
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
	identity: AgentOperationIdentity,
	ensureDurable: () => boolean,
): AgentReplayOutcome<Agent, Agent["operations"][number]> {
	const matches = agents.flatMap((agent) =>
		agent.operations.flatMap((operation) => (operation.operationId === operationId ? [{ agent, operation }] : [])),
	);
	if (matches.length === 0) return { kind: "none" };
	if (matches.length > 1) return { kind: "conflict", reason: "operation ID was reused with different input" };
	const { agent, operation } = matches[0]!;
	// Compared through the verdict rather than by `!==`, so a record written before the model joined
	// the identity still replays instead of answering 400 to every retry of a pre-existing agent.
	//
	// `unverifiable` goes the OPPOSITE way here to the way it goes in a schema, and that is the point
	// of it having three values. A schema asks "may I keep this record", so an unrecomputable
	// fingerprint must not drop it. This asks "may I tell the caller their original operation
	// stands", and an unrecomputable fingerprint cannot show the input was the same, so it must not.
	if (agentFingerprintVerdict(operation.fingerprint, identity) !== "match")
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
