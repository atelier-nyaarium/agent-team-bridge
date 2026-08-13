import type { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId, agentCapabilityId, agentEnableEnvVar } from "./agent-backend.js";
import type { CapabilityBundleSchema, CapabilitySnapshotSchema, EnabledPluginSchema } from "./schemas.js";

////////////////////////////////
//  Interfaces & Types

export type Capability = z.infer<typeof EnabledPluginSchema>;
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;
export type CapabilityBundle = z.infer<typeof CapabilityBundleSchema>;

////////////////////////////////
//  Functions & Helpers

/** A source that has never spoken. Distinct from one that spoke and declared nothing. */
export const UNREPORTED_CAPABILITIES: CapabilitySnapshot = { known: false, capabilities: [], clientVersions: [] };

export const CODEX_THINKING_CAPABILITY_ID = agentCapabilityId("codex");
export const COPILOT_THINKING_CAPABILITY_ID = agentCapabilityId("copilot");

// Served only by switchboard_capabilities. The always-on block carries names alone, so length here
// is not charged against the MCP server instructions.
export const CODEX_THINKING_INSTRUCTIONS = `
# Codex Thinking

Codex agents are enabled. A Codex agent is a second-model-family thread this session owns, for handing off a self-contained sub-task.

## Sandbox

Codex sandbox denies outbound network access. Writes can only happen in the directory you start it in. Otherwise, all other executions are permitted.

GPT-family agents are **very literal** and pursue a goal through unexpected or suspect actions. Set guardrails in the prompt you delegate.

But, choose your terms **very literally**, because if you say "Never" in the beginning, Codex might not listen to you even if you say "It's OK now".
- "Don't XXX." - Means you will never lift the restriction. Trashing the thread is the only way around.
- "Don't XXX, unless I say otherwise later" - Means you may lift the restriction depending on feel.

## Driving Codex Agent manually

- An agent can hold several Codex threads at once. Issue the codexStartAgent calls in parallel to run concurrently.
- For developing, reuse the thread. For one-off audits, prefer a fresh thread for an empty context and fresh eyes.
- For one-offs, give them a markdown Report format.
- You are the triage gate for what codex says and does. A confident tone is not evidence; verify against the code.

## Shaping a Codex Agent Workflow

Fan-out dimensions run on Codex: Audits, assessments, adversarial second reads.

Research is the exception, web research especially. It stays on Opus.

Ask once before fanning out whether the dimensions should be Codex or Claude. Left to you, choose Codex for anything that is not research.

The last consolidating steps always runs on Claude. Don't pipe a Codex to a Codex. Choose model depending on task: Sonnet collates, Opus decides.

Shapes that work, not an exhaustive list:
- Research (Opuses)                  -> Rank (Sonnet)
- Audit (Codexes)                    -> Synthesize (Sonnet)
- Architecture assessment (Codexes)  -> Synthesize (Opus)
- Iterative fix until pass (Codex)   -> Report (Sonnet)

## Recovery

Codex agents belong to the whole Claude Code session. If a Workflow caller dies, \`codexListAgents\` returns every thread with its full history, so recover or re-run the collection.
`.trim();

export const COPILOT_THINKING_INSTRUCTIONS = `
# Copilot Agent

Copilot Agents are enabled. Use them for self-contained coding tasks through the logged-in Copilot CLI.

Use \`copilotStartAgent\` for a fresh task, \`copilotMessageAgent\` for an idle follow-up, \`copilotAwaitAgent\` to wait,
\`copilotStopAgent\` to stop the current turn, and \`copilotListAgents\` to inspect existing agents.
Copilot uses the normal CLI login. Run \`copilot\` and \`/login\` if authentication is required.
`.trim();

// Guidance is capability payload, not a backend fact, so it lives here beside the other capability
// prose rather than on the descriptor.
const AGENT_BACKEND_INSTRUCTIONS: Record<AgentBackendId, string> = {
	codex: CODEX_THINKING_INSTRUCTIONS,
	copilot: COPILOT_THINKING_INSTRUCTIONS,
};

// An empty array is an affirmative "nothing enabled" rather than silence, which is what lets a
// disabled daemon replace a declaration it made while the feature was on.
export function daemonCapabilityDeclaration(env: Record<string, string | undefined>): Capability[] {
	return AGENT_BACKENDS.flatMap((backend) =>
		env[agentEnableEnvVar(backend.id)] === "true"
			? [{ id: agentCapabilityId(backend.id), instructions: AGENT_BACKEND_INSTRUCTIONS[backend.id] }]
			: [],
	);
}

/**
 * The bundle flattened for a consumer that only needs the list.
 *
 * `known` is an AND: a source that has said nothing leaves the answer silent about the ids only it
 * reports, and calling that complete is what lets one source's empty declaration answer for another.
 * Ids are disjoint by ownership, so first-wins on a collision only settles a misconfiguration.
 */
export function unionCapabilities(bundle: CapabilityBundle): CapabilitySnapshot {
	const sections = [bundle.console, bundle.daemon];
	const byId = new Map<string, Capability>();
	for (const section of sections) {
		for (const capability of section.capabilities) {
			if (!byId.has(capability.id)) byId.set(capability.id, capability);
		}
	}
	return {
		known: sections.every((s) => s.known),
		capabilities: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
		clientVersions: [...new Set(sections.flatMap((s) => s.clientVersions))].sort(),
	};
}
