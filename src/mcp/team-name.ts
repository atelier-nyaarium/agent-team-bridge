import crypto from "node:crypto";
import { composeSessionName, isComposite } from "../shared/session-id.js";

////////////////////////////////
//  Functions & Helpers

/** Random 6-char id for an unnamed peer session. The console gives it a friendly label. */
export function randomTeamId(): string {
	return crypto.randomBytes(3).toString("hex");
}

/**
 * The stable per-session team name: a 6-hex digest of the Claude Code harness's
 * `CLAUDE_CODE_SESSION_ID`, so a plugin reload or a restart + `/resume` re-registers the SAME name
 * and the phone thread (keyed `conv.<phoneId>.<domain>.<gateway>.<spawn>.<session>`) resumes.
 *
 * Returns null - the caller falls back to `randomTeamId()` - only when there is no session id
 * (older harness, `--no-session-persistence`, or the `-p --continue` throwaway id).
 *
 * Only a real claude process reaches this path: an in-process subagent shares the parent's MCP
 * connection and never registers, and a separate teammate process mints its own fresh session id,
 * so no two registering sessions ever derive the same name from another's id.
 *
 * The 6-hex output matches `randomTeamId`'s width and, being hex, is disjoint from the reserved
 * team names (gateway/host), so it can never land on a reserved slot.
 */
export function stableTeamName(sessionId: string | undefined): string | null {
	if (!sessionId) return null;
	return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}

/**
 * Resolve the name this session registers under, from the PROJECT_NAME the environment delivered.
 * Every live registrant must be a COMPOSITE (arity-2) name - a bare arity-1 name is reserved for
 * catalog spawn-points (the load-bearing invariant of the address grammar). So:
 *  - unset: a manually-launched Claude on the host; join under the host spawn-point.
 *  - set but bare (image ENV, manual/VS-Code-direct launch): normalize to a session under that spawn.
 *  - already composite (the daemon's `project.session`): use as-is.
 * Durability is decided later at handshake-confirm (a session with no channel never confirms and so
 * never becomes a record); the composition here is purely a naming step.
 */
export function resolveSessionNaming(
	explicitProject: string | undefined,
	harnessSessionId: string | undefined,
): string {
	if (!explicitProject) {
		return composeSessionName("host", stableTeamName(harnessSessionId) ?? randomTeamId());
	}
	if (!isComposite(explicitProject)) {
		return composeSessionName(explicitProject, stableTeamName(harnessSessionId) ?? randomTeamId());
	}
	return explicitProject;
}
