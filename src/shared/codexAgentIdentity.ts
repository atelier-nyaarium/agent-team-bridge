// Codex delegation: byte/shape bounds, opaque ID shapes, and agent/operation identity. The base
// layer every other codexAgent* file imports from; imports nothing from a sibling domain file.

import { z } from "zod";
import { CODEX_BACKEND } from "./agent-backend.js";
import { AgentOwnerKeySchema } from "./agent-execution-target.js";
import {
	AGENT_ACTIVITY_MAX_BYTES,
	AGENT_ACTIVITY_MAX_ITEMS,
	AGENT_ERROR_MAX_BYTES,
	AGENT_PROMPT_MAX_BYTES,
	type AgentOperationIdentity,
	agentIdForOperation,
	agentOperationFingerprint,
	boundedUtf8,
	sanitizeAgentErrorText,
} from "./agent-record.js";

////////////////////////////////
//  Bounds

export const CODEX_PROMPT_MAX_BYTES = AGENT_PROMPT_MAX_BYTES;
export const CODEX_ACTIVITY_MAX_BYTES = AGENT_ACTIVITY_MAX_BYTES;
export const CODEX_ACTIVITY_MAX_ITEMS = AGENT_ACTIVITY_MAX_ITEMS;
export const CODEX_ERROR_MAX_BYTES = AGENT_ERROR_MAX_BYTES;
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
export const CODEX_WAIT_BUDGET_MS = CODEX_BACKEND.waitBudgetMs;
/** Deliberately not the App Server's own default: a thread runs whatever tier this names, so leaving
 * the choice to the server would silently change what a delegated sub-task is worth. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
/** The faster tier's id, as `serviceTiers` names it. The deprecated spelling `fast` is not it. */
export const CODEX_PRIORITY_SERVICE_TIER = "priority";
/** Not a server id. It travels as a null override, which the App Server answers as its `default`
 * tier. Absent means keep the agent's current tier. */
export const CODEX_STANDARD_SERVICE_TIER = "standard";
export const CodexServiceTierSchema = z.enum([CODEX_PRIORITY_SERVICE_TIER, CODEX_STANDARD_SERVICE_TIER]);

/** Opaque identifier shape shared by every App Server / daemon-minted id field across every domain
 * file below. */
export const OpaqueIdSchema = z.string().min(1).max(512);
export const CodexOperationIdSchema = z.string().uuid();
export const OperationIdSchema = CodexOperationIdSchema;

export { boundedUtf8 };

////////////////////////////////
//  Error text

/** Normalizes untrusted daemon errors before they enter durable or caller-visible state. */
export function sanitizeCodexErrorText(raw: string): string {
	return sanitizeAgentErrorText(raw, CODEX_ERROR_MAX_BYTES);
}

export const CodexErrorTextSchema = boundedUtf8(CODEX_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === sanitizeCodexErrorText(value), "error must be normalized");

////////////////////////////////
//  Identity

export const CodexAgentIdSchema = z.string().regex(CODEX_AGENT_ID_RE);
export const CodexOwnerKeySchema = AgentOwnerKeySchema;
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
	return agentIdForOperation("codex", operationId);
}

export function codexOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return agentOperationFingerprint(kind, agentId, prompt);
}

/** What identifies a Codex operation.
 *
 * Codex needs NO legacy tolerance: it never wrote a model term, and the shared encoding reproduces
 * that spelling exactly for a model-less start, so every record it has ever written still recomputes
 * and a tampered one is still caught. The one case it cannot verify is a pre-migration start that
 * named a model, which is a retry naming a model the record never stored - and that answers
 * `mismatch`, which refuses a replay it cannot prove rather than dropping anything.
 *
 * Kept as a function rather than an inline object so the Copilot twin has something to be a twin OF,
 * and so a Codex-only tolerance later has one place to go. */
export function codexOperationIdentity(
	fields: Omit<AgentOperationIdentity, "legacyModellessStart">,
): AgentOperationIdentity {
	return fields;
}

export type CodexAgentId = z.infer<typeof CodexAgentIdSchema>;
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;
