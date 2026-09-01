import type {
	CodexExecutionTarget,
	CodexPersistedAgent,
	CodexReconciliationFence,
	CodexResolvedTarget,
	CodexServiceTier,
	CodexStoredOperation,
} from "../shared/codex-agent.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentTransitionErrorCode } from "./agentRouteEnvelope.js";
import type { SessionAuthority } from "./sessionAuthority.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: CodexCatalogWriter;
}

export interface OwnedCodexAgent {
	owner: SessionRecord;
	agent: CodexPersistedAgent;
}

export interface OwnedCodexOperation extends OwnedCodexAgent {
	operation: CodexStoredOperation;
}

export interface CodexIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	at: number;
}

export interface CodexStartIntentInput extends CodexIntentInput {
	/** Resolved by the route with any cwd applied, so the persisted record and the dispatched
	 * command cannot name different targets. */
	target: CodexExecutionTarget;
	/** Here for the same reason `target` is: it is part of what was asked for, and the record and the
	 * dispatched command must not name different ones. It reached the daemon without ever reaching
	 * the persisted identity, so a retry that changed the model replayed the original silently. */
	model?: string;
	/** Recorded on the agent so every later dispatch carries it, rather than trusting the App Server
	 * to hold it across a resume. */
	serviceTier?: CodexServiceTier;
}

export interface CodexExistingAgentIntentInput extends CodexIntentInput {
	agentId: string;
	/** Absent leaves the agent on the tier it already has. */
	serviceTier?: CodexServiceTier;
}

export interface CodexStopIntentInput {
	agentId: string;
	operationId: string;
	at: number;
}

export interface CodexDeliveryAcceptance {
	agentId: string;
	operationId: string;
	resolvedTarget: CodexResolvedTarget;
	threadId: string;
	turnId: string;
	delivery: "started" | "steered";
	fence: CodexReconciliationFence;
	at: number;
}

export interface CodexDaemonDeliveryAcceptance extends CodexDeliveryAcceptance {
	ownerKey: string;
}

/**
 * What a caller's own intent did: the answer to `beginStart` / `beginMessage` / `beginStop`.
 *
 * Carries NO `unresolved`. It used to, by being the first member of the acceptance union below, and
 * that field was dead here: `replay()` computed it and no route or test ever read it. One name
 * meaning two things across a union is how the acceptance path's live flag and this path's dead one
 * stayed welded together long enough for nobody to notice the second had stopped meaning anything.
 */
export interface CodexTransitionResult extends OwnedCodexOperation {
	/** Only `committed` authorizes first dispatch. `indeterminate` is an existing unaccepted intent. */
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

/**
 * What a DAEMON's receipt did, which is a different question with a different consequence.
 *
 * Its own type rather than a union over the one above. The fields coincide today; the meanings do
 * not, and `unresolved` here is load-bearing in a way it never was there - it is what decides
 * whether the daemon may retire its only copy of a delivery.
 */
export interface CodexAcceptanceResult extends OwnedCodexOperation {
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
	/** The gateway could not place or persist this receipt, as opposed to deciding it does not belong.
	 * Set when reconciliation could still resolve it, which is what keeps it out of the daemon's
	 * acknowledgement. Read at `applyReceipt`. */
	unresolved?: true;
}

/**
 * What the gateway did with one daemon-sourced event or receipt, and therefore what it owes back.
 *
 * `applied` and `ignored` both mean the daemon may retire it: one changed state, the other never
 * will. `reconcile` is the only outcome that withholds an acknowledgement, because the gateway
 * cannot yet tell whether the event matters.
 */
export type CodexApplication =
	| { disposition: "applied"; owner: SessionRecord; agent: CodexPersistedAgent; catalogRevision: number }
	| { disposition: "ignored"; reason: string }
	| { disposition: "reconcile"; owner: SessionRecord; agent: CodexPersistedAgent }
	/**
	 * The gateway could not build a valid record from this. That is evidence about THIS code, not
	 * about the frame, so it must never be acknowledged: a reducer bug would otherwise make the daemon
	 * delete the only copy of a terminal it was told to keep.
	 */
	| { disposition: "failed"; reason: string };

export type CodexTransitionErrorCode = AgentTransitionErrorCode;

////////////////////////////////
//  Class

export class CodexTransitionError extends Error {
	constructor(
		readonly code: CodexTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CodexTransitionError";
	}
}
