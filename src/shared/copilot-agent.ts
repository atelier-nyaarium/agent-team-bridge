// The Copilot delegation wire truth - zod schemas, bounds, and pure helpers - split by domain into
// sibling copilotAgent*.ts files. This barrel re-exports the original public surface so no importer
// changes.

export * from "./copilotAgentActivities.js";
export * from "./copilotAgentCatalog.js";
export type { CopilotAgentId } from "./copilotAgentIdentity.js";
// copilotAgentIdentity.js also re-exports boundedUtf8, module-public only so sibling split files
// can import it across the new boundaries; the named list keeps it out of this module's original
// public surface.
export {
	COPILOT_ACTIVITY_MAX_BYTES,
	COPILOT_ACTIVITY_MAX_ITEMS,
	COPILOT_AGENT_ID_RE,
	COPILOT_DEFAULT_MODEL,
	COPILOT_ERROR_MAX_BYTES,
	COPILOT_PROMPT_MAX_BYTES,
	COPILOT_WAIT_BUDGET_MS,
	CopilotAgentIdSchema,
	CopilotErrorTextSchema,
	CopilotOpaqueIdSchema,
	CopilotOperationIdSchema,
	CopilotOwnerKeySchema,
	CopilotPromptSchema,
	copilotAgentIdForOperation,
	copilotOperationFingerprint,
	copilotOperationIdentity,
	sanitizeCopilotErrorText,
} from "./copilotAgentIdentity.js";
export * from "./copilotAgentRecord.js";
export * from "./copilotAgentRelay.js";
export * from "./copilotAgentState.js";
export * from "./copilotAgentTargets.js";
