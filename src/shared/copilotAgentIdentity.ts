import { z } from "zod";
import { COPILOT_BACKEND } from "./agent-backend.js";
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

export const COPILOT_PROMPT_MAX_BYTES = AGENT_PROMPT_MAX_BYTES;
export const COPILOT_ACTIVITY_MAX_BYTES = AGENT_ACTIVITY_MAX_BYTES;
export const COPILOT_ACTIVITY_MAX_ITEMS = AGENT_ACTIVITY_MAX_ITEMS;
export const COPILOT_ERROR_MAX_BYTES = AGENT_ERROR_MAX_BYTES;
export const COPILOT_WAIT_BUDGET_MS = COPILOT_BACKEND.waitBudgetMs;
export const COPILOT_DEFAULT_MODEL = "gpt-5.6-luna";
export const COPILOT_AGENT_ID_RE = /^copilot_[0-9a-f]{32}$/;

export const CopilotAgentIdSchema = z.string().regex(COPILOT_AGENT_ID_RE);
export const CopilotOperationIdSchema = z.string().uuid();
export const CopilotOwnerKeySchema = AgentOwnerKeySchema;
export const CopilotOpaqueIdSchema = z.string().min(1).max(512);

export const CopilotPromptSchema = z
	.string()
	.refine((value) => value.trim().length > 0, "prompt must not be blank")
	.refine((value) => new TextEncoder().encode(value).byteLength <= COPILOT_PROMPT_MAX_BYTES, {
		message: `prompt must be at most ${COPILOT_PROMPT_MAX_BYTES} UTF-8 bytes`,
	});

export function sanitizeCopilotErrorText(raw: string): string {
	return sanitizeAgentErrorText(raw, COPILOT_ERROR_MAX_BYTES);
}

export const CopilotErrorTextSchema = boundedUtf8(COPILOT_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === sanitizeCopilotErrorText(value), "error must be normalized");

export { boundedUtf8 };

export function copilotAgentIdForOperation(operationId: string): string {
	return agentIdForOperation("copilot", operationId);
}

/** Legacy modelless starts include a trailing separator in Copilot identity bytes. */
export function copilotOperationIdentity(
	fields: Omit<AgentOperationIdentity, "legacyModellessStart">,
): AgentOperationIdentity {
	return { ...fields, legacyModellessStart: "trailing-separator" };
}

export function copilotOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return agentOperationFingerprint(kind, agentId, prompt);
}

export type CopilotAgentId = z.infer<typeof CopilotAgentIdSchema>;
