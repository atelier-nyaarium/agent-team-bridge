import type { z } from "zod";
import type { EnabledPluginSchema } from "./schemas.js";

////////////////////////////////
//  Interfaces & Types

export type Capability = z.infer<typeof EnabledPluginSchema>;

////////////////////////////////
//  Functions & Helpers

export const CODEX_THINKING_CAPABILITY_ID = "codex-thinking";

// Served only by switchboard_capabilities. The always-on block carries names alone, so length here
// is not charged against the MCP server instructions.
export const CODEX_THINKING_INSTRUCTIONS = [
	"Codex agents are enabled. A Codex agent is a second-model-family thread this session owns, for",
	"handing off a self-contained sub-task.",
	"",
	"Choosing the engine:",
	"- Before fanning out parallel work, ask whether the branches should be Codex or Claude. If it is",
	"  left to you, choose Codex.",
	"- Codex suits self-contained branches: an audit of one subsystem, an adversarial second read, an",
	"  isolated repro. Claude branches suit work needing this repo's conventions and your own session",
	"  context.",
	"",
	"Structuring a fan-out:",
	"- You decide the splits. Each branch is one agent() call in a Workflow script, or one Agent tool",
	"  call, driving a single Codex agent through codexStartAgent and codexMessageAgent.",
	"- Give the branch a schema and have it return Codex's response in a schema field; do not ask it to",
	"  summarize what Codex said. For output too large for a field, have Codex write a scratch file and",
	"  return the path.",
	"- Put constraints in the prompt you delegate. A Codex thread keeps workspace-write and web access",
	"  for its whole life, and GPT-family agents pursue a goal through unexpected or suspect actions.",
	"",
	"Budget and recovery:",
	"- A waiting call blocks up to nine minutes and holds a concurrency slot. Size the fan-out for",
	"  that, or pass awaitResponse: false and collect with codexAwaitAgent.",
	"- Codex agents belong to this session, not to the branch that started one. If a branch dies,",
	"  codexListAgents returns every agent with its full history, so re-run the collection, not the",
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
