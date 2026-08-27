// The Codex delegation wire truth - zod schemas, bounds, and pure helpers (fences, fingerprints,
// target ids) - split by domain into sibling codexAgent*.ts files. This barrel re-exports the
// original public surface so no importer changes. Unlike schemas.ts, none of this feeds the Kotlin codegen (no
// `.meta({id})`, not in scripts/codegen-kotlin.ts's ROOTS), so there is no generated-file ordering
// constraint on the split or on this barrel's (biome-sorted) export order.

export * from "./codexAgentActivities.js";
export * from "./codexAgentAppServer.js";
export * from "./codexAgentCatalog.js";
export type { CodexAgentId } from "./codexAgentIdentity.js";
export {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ACTIVITY_MAX_ITEMS,
	CODEX_AGENT_ID_RE,
	CODEX_DEFAULT_MODEL,
	CODEX_ERROR_MAX_BYTES,
	CODEX_PROMPT_MAX_BYTES,
	CODEX_WAIT_BUDGET_MS,
	CodexAgentIdSchema,
	CodexErrorTextSchema,
	CodexOperationIdSchema,
	CodexOwnerKeySchema,
	CodexPromptSchema,
	codexAgentIdForOperation,
	codexOperationFingerprint,
	codexOperationIdentity,
	sanitizeCodexErrorText,
} from "./codexAgentIdentity.js";
export * from "./codexAgentRecord.js";
export * from "./codexAgentRelay.js";
export type {
	CodexAgentResult,
	CodexErrorCode,
	CodexGatewayRequest,
	CodexListAvailabilityError,
} from "./codexAgentState.js";
// codexAgentState.js and codexAgentIdentity.js re-export by NAME, not `export *`: the
// split made four file-internal helpers (OpaqueIdSchema, OperationIdSchema, boundedUtf8,
// CodexListAvailabilityErrorSchema) module-public so sibling split files could import them across
// the new boundaries, and the named lists keep them out of this module's original public surface.
export {
	CodexAgentResultSchema,
	CodexAgentStateSchema,
	CodexAwaitAgentInputSchema,
	CodexDeliverySchema,
	CodexErrorCodeSchema,
	CodexErrorSchema,
	CodexGatewayRequestSchema,
	CodexListAgentsInputSchema,
	CodexMessageAgentInputSchema,
	CodexObservationSchema,
	CodexRequestErrorSchema,
	CodexStartAgentInputSchema,
	CodexStopAgentInputSchema,
	CodexTurnStateSchema,
} from "./codexAgentState.js";
export * from "./codexAgentTargets.js";
