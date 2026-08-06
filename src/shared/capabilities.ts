import type { z } from "zod";
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

export const CODEX_THINKING_CAPABILITY_ID = "codex-thinking";

// Served only by switchboard_capabilities. The always-on block carries names alone, so length here
// is not charged against the MCP server instructions.
export const CODEX_THINKING_INSTRUCTIONS = [
	"Codex agents are enabled. A Codex agent is a second-model-family thread this session owns, for",
	"handing off a self-contained sub-task.",
	"",
	"Shaping a pipeline:",
	"- Fan-out dimensions run on Codex: an audit of one subsystem, an adversarial second read, an",
	"  isolated repro, an iterative fix.",
	"- Research is the exception, web research especially. It stays on Opus.",
	"- Consolidating steps run on Claude, since a join reads every dimension and needs your session",
	"  context and this repo's conventions. Size it to the work: Sonnet collates, Opus decides.",
	"- Shapes that work, not an exhaustive list:",
	"    Research (Opus)                  -> Rank (Sonnet)",
	"    Audit (Codex)                    -> Synthesize (Sonnet)",
	"    Architecture assessment (Codex)  -> Synthesize (Opus)",
	"    Iterative fix until pass (Codex) -> Report (Sonnet)",
	"- Ask before fanning out whether the dimensions should be Codex or Claude. Left to you, choose",
	"  Codex for anything that is not research.",
	"",
	"Driving them:",
	"- ONE agent can hold several Codex threads at once. Open each with codexStartAgent passing",
	"  awaitResponse: false so they run concurrently, then collect with codexAwaitAgent. Measured",
	"  against the alternative, a wrapper",
	"  agent per Codex thread cost roughly four times the tokens and found no more: the wrappers spend",
	"  their budget re-reading the same files to decide whether to trust what they were told to relay.",
	"- Spend the saved budget on the join instead. Whoever collects should verify what came back.",
	"- Reuse a thread across attempts rather than starting a fresh agent per loop, and re-task the same",
	"  agent when an answer is thin. A thread holding its own last three failures fixes the fourth.",
	"- Give each a schema so it returns data, not prose. Condense where the detail does not change what",
	"  you do next; never paraphrase a finding you will act on.",
	"- Too large to carry back: have Codex write a scratch file and return the path.",
	"- Put constraints in the prompt you delegate. A Codex thread keeps workspace-write and web access",
	"  for its whole life, and GPT-family agents pursue a goal through unexpected or suspect actions.",
	"- The triage gate still applies to what comes back. A confident tone is not evidence; verify",
	"  against the code.",
	"",
	"Budget and recovery:",
	"- A waiting call blocks about four minutes and holds a slot. A turn outliving that is NOT lost: it",
	"  keeps running and codexAwaitAgent collects it, which is also why awaitResponse: false is the",
	"  right default for anything you are running several of.",
	"- Codex agents belong to this session, not to whoever started one. If that caller dies,",
	"  codexListAgents returns every thread with its full history, so re-run the collection, not the",
	"  work.",
	"",
	"Call this tool again after your next context compaction.",
].join("\n");

// An empty array is an affirmative "nothing enabled" rather than silence, which is what lets a
// disabled daemon replace a declaration it made while the feature was on.
export function daemonCapabilityDeclaration(env: Record<string, string | undefined>): Capability[] {
	if (env.CODEX_THINKING_ENABLED !== "true") return [];
	return [{ id: CODEX_THINKING_CAPABILITY_ID, instructions: CODEX_THINKING_INSTRUCTIONS }];
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
