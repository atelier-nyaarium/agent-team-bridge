import { type AgentOperationIdentity, resolveAgentReplay } from "../shared/agent-record.js";
import type { CodexAgentCatalog, CodexPersistedAgent } from "../shared/codex-agent.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import { replaceAt } from "./codexAgentReducers.js";
import { type CodexApplication, CodexTransitionError, type CodexTransitionResult } from "./codexAgentTypes.js";

export interface CodexCatalogDeps {
	sessionStore: SessionStore;
	catalogWriter: CodexCatalogWriter;
}

export function readCodexCatalog(deps: CodexCatalogDeps, owner: SessionRecord): CodexAgentCatalog {
	return deps.sessionStore.codexCatalog(owner) ?? { version: 1, revision: 0, agents: [] };
}

export function codexAgentIndex(catalog: CodexAgentCatalog, agentId: string): number {
	const matches = catalog.agents.flatMap((agent, index) => (agent.agentId === agentId ? [index] : []));
	if (matches.length !== 1) throw new CodexTransitionError("not_found", "agent was not found");
	return matches[0]!;
}

export function codexCatalogDurable(deps: CodexCatalogDeps, owner: SessionRecord, revision: number): boolean {
	if (deps.catalogWriter.isDurable(owner, revision)) return true;
	try {
		return deps.catalogWriter.checkpoint(owner, revision).confirmed;
	} catch {
		return false;
	}
}

export function commitCodexTransition(
	deps: CodexCatalogDeps,
	owner: SessionRecord,
	catalog: CodexAgentCatalog,
	agents: readonly CodexPersistedAgent[],
	agent: CodexPersistedAgent,
	operationId: string,
): CodexTransitionResult {
	let committed;
	try {
		committed = deps.catalogWriter.commit(owner, catalog.revision, agents);
	} catch (error) {
		throw new CodexTransitionError("persistence_failed", "Codex transition could not be persisted", {
			cause: error,
		});
	}
	if (!committed.committed) {
		throw new CodexTransitionError("state_conflict", `catalog commit failed: ${committed.reason}`);
	}
	const storedAgent = committed.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
	const operation = storedAgent.operations.find((candidate) => candidate.operationId === operationId)!;
	return {
		owner,
		agent: storedAgent,
		operation,
		disposition: "committed",
		catalogRevision: committed.catalog.revision,
	};
}

export function applyCodexAgent(
	deps: CodexCatalogDeps,
	owner: SessionRecord,
	catalog: CodexAgentCatalog,
	index: number,
	next: CodexPersistedAgent,
): CodexApplication {
	let committed;
	try {
		committed = deps.catalogWriter.commit(owner, catalog.revision, replaceAt(catalog.agents, index, next));
	} catch {
		// Unpersisted events remain unacknowledged, or the daemon retires them.
		return { disposition: "reconcile", owner, agent: next };
	}
	if (!committed.committed) return { disposition: "reconcile", owner, agent: next };
	const agent = committed.catalog.agents.find((candidate) => candidate.agentId === next.agentId)!;
	return { disposition: "applied", owner, agent, catalogRevision: committed.catalog.revision };
}

export function replayCodexTransition(
	deps: CodexCatalogDeps,
	owner: SessionRecord,
	operationId: string,
	identity: AgentOperationIdentity,
): CodexTransitionResult | null {
	const catalog = readCodexCatalog(deps, owner);
	const found = resolveAgentReplay(catalog.agents, operationId, identity, () =>
		codexCatalogDurable(deps, owner, catalog.revision),
	);
	if (found.kind === "none") return null;
	if (found.kind === "conflict") throw new CodexTransitionError("operation_conflict", found.reason);
	return {
		owner,
		agent: found.agent,
		operation: found.operation,
		disposition: found.replayable ? "replayed" : "indeterminate",
		catalogRevision: catalog.revision,
	};
}
