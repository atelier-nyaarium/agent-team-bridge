import crypto from "node:crypto";

////////////////////////////////
//  Functions & Helpers

/** Random 6-char id for an unnamed peer session. The console gives it a friendly label. */
export function randomTeamId(): string {
	return crypto.randomBytes(3).toString("hex");
}

/**
 * The stable per-window team name for a TOP-LEVEL unstable session: a 6-hex digest of the Claude
 * Code harness's `CLAUDE_CODE_SESSION_ID`, so a plugin reload or a restart + `/resume` re-registers
 * the SAME name and the phone thread (keyed `conv:<phoneId>:<gateway/teamName>`) resumes.
 *
 * Returns null - the caller falls back to `randomTeamId()` - in the cases that have no resumable
 * phone thread, matching today's behavior:
 *  - a subagent (`CLAUDE_CODE_CHILD_SESSION`), which INHERITS the parent's session id and would
 *    otherwise collide on the parent's name and receive its phone pushes;
 *  - no session id at all (older harness, `--no-session-persistence`, or the `-p --continue`
 *    throwaway id).
 *
 * The 6-hex output matches `randomTeamId`'s width and, being hex, is disjoint from the reserved
 * team names (gateway/host), so it can never land on a reserved slot.
 */
export function stableTeamName(sessionId: string | undefined, isChild: boolean): string | null {
	if (!sessionId || isChild) return null;
	return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}
