import type { PendingJobStore } from "../../shared/pending-job-store.js";
import type { ResponsePayload } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";
import { presentedByRequest, type SessionAuthority } from "../sessionAuthority.js";

// Owner data requires a bound session. Session scope permits unbound names.
export type CallerScope = "session" | "owner-data";

export interface CallerGuardsDeps {
	auth?: SessionAuthority;
	store: Pick<PendingJobStore<ResponsePayload>, "askerOf">;
}

export type CallerGuards = ReturnType<typeof createCallerGuards>;

export function createCallerGuards({ auth, store }: CallerGuardsDeps) {
	function provedLocalSession(req: Request): boolean {
		return !auth || auth.mayUseLocalPlane(presentedByRequest(req));
	}

	function refuseImpersonation(req: Request, claimed: string, scope: CallerScope): Response | null {
		// Refuse unresolved names; the recipient sees `from` verbatim.
		if (!auth) return null;
		// Owner data is not addressed to a session, so naming one proves no right to it.
		if (scope === "owner-data" && !provedLocalSession(req)) {
			console.warn(`[auth] refused an owner-data call claiming "${claimed}" without any session binding`);
			return jsonResponse({ error: "the owner's own data is not open to this caller" }, 403);
		}
		const key = auth.localTeamKey(claimed);
		if (key === null) {
			// Malformed rather than unauthorized: the name cannot denote any session here.
			return jsonResponse({ error: `Invalid sender: "${claimed}" does not name a local session` }, 400);
		}
		if (auth.satisfies(auth.toClaim(key), presentedByRequest(req))) return null;
		console.warn(`[auth] refused a call claiming "${claimed}" without its binding`);
		return jsonResponse({ error: "sender is not this caller's session" }, 403);
	}

	function refuseForeignReply(req: Request, target: string): Response | null {
		// Remote replies arrive through sealed relay, never local HTTP.
		if (!auth) return null;
		const key = auth.localTeamKey(target);
		if (key === null) {
			console.warn(`[auth] refused a local reply to "${target}", which is not a local session`);
			return jsonResponse({ error: "reply target is not a local session" }, 403);
		}
		if (auth.satisfies(auth.toActFor(key), presentedByRequest(req))) return null;
		console.warn(`[auth] refused a reply addressed to "${target}" from another session`);
		return jsonResponse({ error: "reply is not from this conversation's session" }, 403);
	}

	function refuseForeignPoll(req: Request, sessionId: string): Response | null {
		if (!auth) return null;
		const asker = store.askerOf(sessionId);
		// Preserve 404 for unknown jobs and hide foreign asker existence.
		if (asker === undefined) return null;
		const key = auth.localTeamKey(asker);
		if (key === null) {
			console.warn(`[auth] refused a local poll of a job asked by "${asker}", which is not a local session`);
			return jsonResponse({ error: "this job's answer is not collected over local HTTP" }, 403);
		}
		if (auth.satisfies(auth.toActFor(key), presentedByRequest(req))) return null;
		console.warn(`[auth] refused a poll of a job asked by "${asker}" from another session`);
		return jsonResponse({ error: `No pending job for session_id "${sessionId}"` }, 404);
	}

	return { provedLocalSession, refuseImpersonation, refuseForeignReply, refuseForeignPoll };
}
