import crypto from "node:crypto";
import { composeSessionName, isComposite } from "../shared/session-id.js";

////////////////////////////////
//  Functions & Helpers

/** Random 6-char id for an unnamed peer session. The console gives it a friendly label. */
export function randomTeamId(): string {
	return crypto.randomBytes(3).toString("hex");
}

/**
 * A 6-hex digest of `CLAUDE_CODE_SESSION_ID`, stable across a reload but NOT a restart: `--resume`
 * forks a fresh id, so the phone thread keeps addressing a session that no longer registers. Only
 * the daemon's PROJECT_NAME pin survives a restart; this is the fallback for launches with none.
 *
 * Null (falls back to `randomTeamId()`) only when there is no session id at all.
 */
export function stableTeamName(sessionId: string | undefined): string | null {
	if (!sessionId) return null;
	return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}

/**
 * A bare (arity-1) name is reserved for spawn-points, so every registrant must be COMPOSITE:
 *  - unset: a manual host launch, joins the host spawn-point.
 *  - bare: normalized to a session under that spawn.
 *  - already composite: used as-is.
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
