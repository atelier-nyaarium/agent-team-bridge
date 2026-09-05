import { type AgentOperationIdentity, resolveAgentReplay } from "../shared/agent-record.js";
import type { CopilotAgentCatalog, CopilotPersistedAgent } from "../shared/copilot-agent.js";
import type { CopilotCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import { replaceAt } from "./copilotAgentReducers.js";
import { type CopilotApplication, CopilotTransitionError, type CopilotTransitionResult } from "./copilotAgentTypes.js";

export interface CopilotCatalogDeps {
	sessionStore: SessionStore;
	catalogWriter: CopilotCatalogWriter;
}

export function readCopilotCatalog(deps: CopilotCatalogDeps, owner: SessionRecord): CopilotAgentCatalog {
	return deps.sessionStore.copilotCatalog(owner) ?? { version: 1, revision: 0, agents: [] };
}

export function copilotAgentIndex(catalog: CopilotAgentCatalog, agentId: string): number {
	const index = catalog.agents.findIndex((agent) => agent.agentId === agentId);
	if (index < 0) throw new CopilotTransitionError("not_found", "Copilot agent was not found");
	return index;
}

export function copilotCatalogDurable(deps: CopilotCatalogDeps, owner: SessionRecord, revision: number): boolean {
	if (deps.catalogWriter.isDurable(owner, revision)) return true;
	try {
		return deps.catalogWriter.checkpoint(owner, revision).confirmed;
	} catch {
		return false;
	}
}

export function commitCopilotTransition(
	deps: CopilotCatalogDeps,
	owner: SessionRecord,
	catalog: CopilotAgentCatalog,
	agents: readonly CopilotPersistedAgent[],
	agent: CopilotPersistedAgent,
	operationId: string,
): CopilotTransitionResult {
	let committed;
	try {
		committed = deps.catalogWriter.commit(owner, catalog.revision, agents);
	} catch (error) {
		throw new CopilotTransitionError("persistence_failed", "Copilot transition could not be persisted", {
			cause: error,
		});
	}
	if (!committed.committed)
		throw new CopilotTransitionError("persistence_failed", "Copilot catalog changed while saving");
	const storedAgent = committed.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
	return {
		disposition: "committed",
		owner,
		agent: storedAgent,
		operation: storedAgent.operations.find((operation) => operation.operationId === operationId)!,
		catalogRevision: committed.catalog.revision,
	};
}

export function applyCopilotAgent(
	deps: CopilotCatalogDeps,
	owner: SessionRecord,
	previous: CopilotPersistedAgent,
	next: CopilotPersistedAgent,
): CopilotApplication {
	const catalog = readCopilotCatalog(deps, owner);
	const index = copilotAgentIndex(catalog, previous.agentId);
	let committed;
	try {
		committed = deps.catalogWriter.commit(owner, catalog.revision, replaceAt(catalog.agents, index, next));
	} catch {
		// Reconcile unpersisted events; never acknowledge them.
		return { disposition: "reconcile", owner, agent: next };
	}
	if (!committed.committed) return { disposition: "reconcile", owner, agent: next };
	return {
		disposition: "applied",
		owner,
		agent: committed.catalog.agents.find((agent) => agent.agentId === next.agentId)!,
		catalogRevision: committed.catalog.revision,
	};
}

export function replayCopilotTransition(
	deps: CopilotCatalogDeps,
	owner: SessionRecord,
	operationId: string,
	identity: AgentOperationIdentity,
): CopilotTransitionResult | null {
	const catalog = readCopilotCatalog(deps, owner);
	const found = resolveAgentReplay(catalog.agents, operationId, identity, () =>
		copilotCatalogDurable(deps, owner, catalog.revision),
	);
	if (found.kind === "none") return null;
	if (found.kind === "conflict") throw new CopilotTransitionError("operation_conflict", found.reason);
	return {
		disposition: found.replayable ? "replayed" : "indeterminate",
		owner,
		agent: found.agent,
		operation: found.operation,
		catalogRevision: catalog.revision,
	};
}
