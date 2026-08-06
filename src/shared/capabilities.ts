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
	"Choosing the engine:",
	"- Before fanning out, ask whether the dimensions should run on Codex or Claude. Left to you,",
	"  choose Codex.",
	"- Codex suits a dimension: an audit of one subsystem, an adversarial second read, an isolated",
	"  repro. Synthesis stays on Claude, since a join needs your session context and this repo's",
	"  conventions.",
	"",
	"Driving one from a dimension:",
	"- The agent on a dimension owns its Codex thread for that thread's life, starting it with",
	"  codexStartAgent and following up with codexMessageAgent until its question is settled.",
	"- Give each a schema so it returns data, not prose. Condense where the detail does not change what",
	"  you do next; never paraphrase a finding you will act on.",
	"- Too large to carry back: have Codex write a scratch file and return the path.",
	"- Put constraints in the prompt you delegate. A Codex thread keeps workspace-write and web access",
	"  for its whole life, and GPT-family agents pursue a goal through unexpected or suspect actions.",
	"- The triage gate still applies to what comes back. A confident tone is not evidence; verify",
	"  against the code.",
	"",
	"Budget and recovery:",
	"- A waiting call blocks up to nine minutes and holds a concurrency slot. Size the fan-out for",
	"  that, or pass awaitResponse: false and collect with codexAwaitAgent.",
	"- Codex agents belong to this session, not to the dimension that started one. If an agent dies,",
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
