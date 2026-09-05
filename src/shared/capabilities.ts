import type { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId, agentCapabilityId } from "./agent-backend.js";
import { isAgentBackendInstalled } from "./agent-binary.js";
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

export const CODEX_AGENT_CAPABILITY_ID = agentCapabilityId("codex");
export const COPILOT_AGENT_CAPABILITY_ID = agentCapabilityId("copilot");

// Served only by switchboard_capabilities. The always-on block carries names alone, so length here
// is not charged against the MCP server instructions.
export const CODEX_AGENT_INSTRUCTIONS = `
# Codex Agent

Codex Agents are enabled. A Codex agent is a second-model-family thread this session owns, for handing off a self-contained sub-task.

Start with \`codexStartAgent\`.

GPT-family agents are **very literal** and pursue a goal through unexpected or suspect actions. Set guardrails in the prompt you delegate.
But, choose your terms **very literally**, because if you say "Never" in the beginning, GPT might not listen to you even if you say "It's OK now".
- "Don't XXX." - Means you will never lift the restriction. Trashing the thread is the only way around.
- "Don't XXX, unless I say otherwise later" - Means you may lift the restriction depending on feel.

You are the triage gate for what Codex says and does. A confident tone is not evidence; verify their work and claims against the code.

Codex sandbox denies outbound network access. Writes can only happen in the directory you start it in. Otherwise, all other executions are permitted.

## Driving a Codex Agent Workflow

To keep your context free of clutter, it's recommended to use Workflows.

Code editing or fan-outs run on Codex: Audits, assessments, adversarial second reads.

Research is the exception, web research especially. It stays on Opus.

Choose model depending on task:
- Haiku relays verbatim to Codex. Or Sonnet if you want to remove a whole report phase.
- Sonnet collates, Opus decides.

Single Iterative Phase Style:
- Iterative fix until pass (Sonnet working with Codexes) and report

Fan Out ► Join Style
- Research (Opuses) ► Rank Sort (Opus or Sonnet)
- Audits (Haikus verbatim Codexes) ► Synthesize (Opus)
- Assessments (Haikus verbatim Codexes) ► Synthesize (Opus)

## Recovery

Codex agents belong to the whole Claude Code session. A terminal result means finished. \`agent_dead\` means the agent cannot run. \`agent_unreachable\` means its App Server may still be running, so do not duplicate the work. If a Workflow caller dies, \`codexListAgents\` returns a bounded summary; pass \`agentId\` to inspect one agent's full history.
`.trim();

export const VAULT_INSTRUCTIONS = `
# Vault

The owner's secrets, approved per use from the phone. No tool ever answers a value.

- \`vault_search\` lists entries by public title and description with their ids.
- \`vault_run\` runs a shell command with one entry's value injected: as \`$VAULT_VALUE\` (or the env name you choose), on stdin followed by a newline, or as a 0600 file at \`$VAULT_FILE\` on tmpfs when there is one. Naming an entry asks the owner to approve the command, so name the real one; a vague command earns a denial.
- A run that outlives the wait (230 seconds per call) answers \`pending\` (the owner has not answered) or \`running\` (the command has not exited). \`vault_collect\` with the \`jobId\` continues it; \`vault_withdraw\` gives the request up.
- A \`refused\` answer with a \`note\` is the owner steering you. Do what the note says instead of asking again.
- \`capture\` on a run stores the command's stdout as a new entry the owner can edit on the phone. Use it to generate a secret that must never enter the transcript.

stdout and stderr come back with the value's bytes replaced by \`[vault]\`. Never echo a value into a file the transcript can read, and never put it on a command line: \`ps\` shows argv.
`.trim();

export const COPILOT_AGENT_INSTRUCTIONS = `
# Copilot Agent

Copilot Agents are enabled. A Copilot agent is a second-model-family thread this session owns, for handing off a self-contained sub-task.

Start with \`copilotStartAgent\`.

GPT-family agents are **very literal** and pursue a goal through unexpected or suspect actions. Set guardrails in the prompt you delegate.
But, choose your terms **very literally**, because if you say "Never" in the beginning, GPT might not listen to you even if you say "It's OK now".
- "Don't XXX." - Means you will never lift the restriction. Trashing the thread is the only way around.
- "Don't XXX, unless I say otherwise later" - Means you may lift the restriction depending on feel.

You are the triage gate for what Copilot says and does. A confident tone is not evidence; verify their work and claims against the code.

## Driving a Copilot Agent Workflow

To keep your context free of clutter, it's recommended to use Workflows.

Code editing or fan-outs run on Copilot: Audits, assessments, adversarial second reads.

Research is the exception, web research especially. It stays on Opus.

Choose model depending on task:
- Haiku relays verbatim to Copilot. Or Sonnet if you want to remove a whole report phase.
- Sonnet collates, Opus decides.

Single Iterative Phase Style:
- Iterative fix until pass (Sonnet working with Copilots) and report

Fan Out ► Join Style
- Research (Opuses) ► Rank Sort (Opus or Sonnet)
- Audits (Haikus verbatim Copilots) ► Synthesize (Opus)
- Assessments (Haikus verbatim Copilots) ► Synthesize (Opus)

## Recovery

Copilot agents belong to the whole Claude Code session. If a Workflow caller dies, \`copilotListAgents\` returns every thread with its full history, so recover or re-run the collection.
`.trim();

// Guidance is capability payload, not a backend fact, so it lives here beside the other capability
// prose rather than on the descriptor.
const AGENT_BACKEND_INSTRUCTIONS: Record<AgentBackendId, string> = {
	codex: CODEX_AGENT_INSTRUCTIONS,
	copilot: COPILOT_AGENT_INSTRUCTIONS,
};

/**
 * What the daemon can actually run, probed rather than configured.
 *
 * A backend's CLI being installed is the whole opt-in: an owner who installed Codex wants Codex, and
 * an extra flag in a file only this repo knows about could only ever disagree with that. An empty
 * array is an affirmative "nothing available" rather than silence, which is what lets a daemon that
 * lost a binary replace a declaration it made while the CLI was there.
 */
export function daemonCapabilityDeclaration(env: Record<string, string | undefined>): Capability[] {
	return AGENT_BACKENDS.flatMap((backend) =>
		isAgentBackendInstalled(backend, env)
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
