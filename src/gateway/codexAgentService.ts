import {
	CodexAgentIdSchema,
	type CodexExecutionTarget,
	CodexExecutionTargetSchema,
	CodexOperationIdSchema,
	type CodexPersistedAgent,
	type CodexStoredOperation,
} from "../shared/codex-thinking.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { SessionAuthority } from "./sessionAuthority.js";

export interface CodexAgentCatalogReader {
	list(owner: SessionRecord): readonly CodexPersistedAgent[];
}

export interface CodexAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	agentCatalog: CodexAgentCatalogReader;
}

export interface OwnedCodexAgent {
	owner: SessionRecord;
	agent: CodexPersistedAgent;
}

export interface OwnedCodexOperation extends OwnedCodexAgent {
	operation: CodexStoredOperation;
}

/** Session-owned gateway boundary for Codex access and state transitions. Route and daemon
 * adapters resolve through this service rather than receiving catalog authority directly. */
export class CodexAgentService {
	private readonly auth: SessionAuthority;
	private readonly sessionStore: SessionStore;
	private readonly offlineCatalog: ReadonlyMap<string, string>;
	private readonly agentCatalog: CodexAgentCatalogReader;

	constructor(deps: CodexAgentServiceDeps) {
		this.auth = deps.auth;
		this.sessionStore = deps.sessionStore;
		this.offlineCatalog = deps.offlineCatalog;
		this.agentCatalog = deps.agentCatalog;
	}

	resolveOwner(req: Request): SessionRecord | null {
		return this.auth.resolveConfirmedManagedSession(req);
	}

	resolveExecutionTarget(owner: SessionRecord): CodexExecutionTarget | null {
		let target: CodexExecutionTarget;
		if (owner.spawn === "host") {
			target = { kind: "host", workdirHint: this.sessionStore.hostWorkdirHint(owner) };
		} else {
			const hostProjectPath = this.offlineCatalog.get(owner.spawn);
			if (!hostProjectPath) return null;
			target = { kind: "devcontainer", project: owner.spawn, hostProjectPath };
		}
		const validated = CodexExecutionTargetSchema.safeParse(target);
		return validated.success ? validated.data : null;
	}

	resolveOwnedAgent(req: Request, agentId: string): OwnedCodexAgent | null {
		if (!CodexAgentIdSchema.safeParse(agentId).success) return null;
		const owner = this.resolveOwner(req);
		if (!owner) return null;
		const matches = this.agentCatalog.list(owner).filter((agent) => agent.agentId === agentId);
		return matches.length === 1 ? { owner, agent: matches[0]! } : null;
	}

	resolveOwnedOperation(req: Request, agentId: string, operationId: string): OwnedCodexOperation | null {
		if (!CodexOperationIdSchema.safeParse(operationId).success) return null;
		const owned = this.resolveOwnedAgent(req, agentId);
		if (!owned) return null;
		const matches = owned.agent.operations.filter((operation) => operation.operationId === operationId);
		return matches.length === 1 ? { ...owned, operation: matches[0]! } : null;
	}
}
