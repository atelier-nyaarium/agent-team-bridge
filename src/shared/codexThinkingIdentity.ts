// Codex delegation: byte/shape bounds, opaque ID shapes, and agent/operation identity. The base
// layer every other codexThinking* file imports from; imports nothing from a sibling domain file.

import crypto from "node:crypto";
import { z } from "zod";
import { isComposite, isSlug, parseSessionName } from "./session-id.js";

////////////////////////////////
//  Bounds

export const CODEX_PROMPT_MAX_BYTES = 256 * 1024;
export const CODEX_ACTIVITY_MAX_BYTES = 16 * 1024;
export const CODEX_ACTIVITY_MAX_ITEMS = 32;
export const CODEX_ERROR_MAX_BYTES = 16 * 1024;
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
export const CODEX_WAIT_BUDGET_MS = 240_000;
/** Deliberately not the App Server's own default: a thread runs whatever tier this names, so leaving
 * the choice to the server would silently change what a delegated sub-task is worth. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-terra";

/** Opaque identifier shape shared by every App Server / daemon-minted id field across every domain
 * file below. */
export const OpaqueIdSchema = z.string().min(1).max(512);
export const CodexOperationIdSchema = z.string().uuid();
export const OperationIdSchema = CodexOperationIdSchema;

export function boundedUtf8(maxBytes: number, name: string) {
	return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
		message: `${name} must be at most ${maxBytes} UTF-8 bytes`,
	});
}

////////////////////////////////
//  Error text

/** Normalizes untrusted daemon errors before they enter durable or caller-visible state. */
export function sanitizeCodexErrorText(raw: string): string {
	const normalized = raw
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (new TextEncoder().encode(normalized).byteLength <= CODEX_ERROR_MAX_BYTES) return normalized;

	let result = "";
	let bytes = 0;
	for (const character of normalized) {
		const characterBytes = new TextEncoder().encode(character).byteLength;
		if (bytes + characterBytes > CODEX_ERROR_MAX_BYTES) break;
		result += character;
		bytes += characterBytes;
	}
	return result.trimEnd();
}

export const CodexErrorTextSchema = boundedUtf8(CODEX_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === sanitizeCodexErrorText(value), "error must be normalized");

////////////////////////////////
//  Identity

export const CodexAgentIdSchema = z.string().regex(CODEX_AGENT_ID_RE);
export const CodexOwnerKeySchema = z
	.string()
	.min(3)
	.max(129)
	.refine((value) => {
		if (!isComposite(value)) return false;
		const { project, session } = parseSessionName(value);
		return isSlug(project) && isSlug(session);
	}, "owner key must contain two canonical slugs");
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
	const digest = crypto.createHash("sha256").update(`CODEX_AGENT_V1\n${operationId}`).digest("hex");
	return `codex_${digest.slice(0, 32)}`;
}

export function codexOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify([kind, agentId, prompt ?? null]))
		.digest("hex");
}

export type CodexAgentId = z.infer<typeof CodexAgentIdSchema>;
