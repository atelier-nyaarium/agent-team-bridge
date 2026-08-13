// The delegated-agent backend registry: which second-model backends exist, and every name derived
// from a backend's id. Sole source of the capability id, enable switch, env prefix, HTTP path, wire
// frame types and tool prefix, so the layers that read them cannot disagree on a spelling. A pure
// leaf: no imports, readable by the MCP, the gateway and the daemon alike.

////////////////////////////////
//  Interfaces & Types

export type AgentBackendId = "codex" | "copilot";

/** Inert per-backend facts. Data only; behavior stays in each layer's own adapter. */
export interface AgentBackendDescriptor {
	readonly id: AgentBackendId;
	readonly displayName: string;
	/** How long a waiting gateway call may block. Bounded by the CLIENT: node's fetch abandons a
	 * silent connection at 300s, and a replayed operation is never re-dispatched, so a longer hold
	 * could never deliver its answer. */
	readonly waitBudgetMs: number;
}

export type AgentFrameKind = "command" | "receipt" | "event" | "ack" | "hello";

////////////////////////////////
//  Functions & Helpers

const AGENT_WAIT_BUDGET_MS = 240_000;

export const CODEX_BACKEND: AgentBackendDescriptor = {
	id: "codex",
	displayName: "Codex",
	waitBudgetMs: AGENT_WAIT_BUDGET_MS,
};

export const COPILOT_BACKEND: AgentBackendDescriptor = {
	id: "copilot",
	displayName: "Copilot",
	waitBudgetMs: AGENT_WAIT_BUDGET_MS,
};

/** Adding a backend means adding its descriptor here; every derived surface follows. */
export const AGENT_BACKENDS: readonly AgentBackendDescriptor[] = [CODEX_BACKEND, COPILOT_BACKEND];

export function agentCapabilityId(id: AgentBackendId): string {
	return `${id}-thinking`;
}

export function agentEnableEnvVar(id: AgentBackendId): string {
	return `${id.toUpperCase()}_AGENT_ENABLED`;
}

/** Env prefix carried into a container and exempted from the child-env secret scrub. */
export function agentEnvPrefix(id: AgentBackendId): string {
	return `${id.toUpperCase()}_`;
}

export function agentHttpPath(id: AgentBackendId): string {
	return `/${id}`;
}

export function agentFrameType(id: AgentBackendId, kind: AgentFrameKind): string {
	return `${id}_${kind}`;
}

/** The frame types a daemon sends the gateway. `command` and `ack` travel the other way. */
export function agentInboundFrameTypes(id: AgentBackendId): ReadonlySet<string> {
	return new Set([agentFrameType(id, "hello"), agentFrameType(id, "receipt"), agentFrameType(id, "event")]);
}
