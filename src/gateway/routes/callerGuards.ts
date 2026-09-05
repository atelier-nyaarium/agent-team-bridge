import type { PendingJobStore } from "../../shared/pending-job-store.js";
import type { ResponsePayload } from "../../shared/types.js";
import { jsonResponse } from "../routeSchemas.js";
import { presentedByRequest, type SessionAuthority } from "../sessionAuthority.js";

/**
 * What a caller is asking to act as, which decides what naming a session proves.
 *
 * "session": the call acts AS the named session, so an unbound name passing is correct - that is
 * what keeps a hand-launched session sending. "owner-data": the call reads or writes the OWNER's
 * own board or mailbox, which no session name can speak for, so the caller must additionally prove
 * it is one of this gateway's bound sessions. Required rather than defaulted: a new route is then a
 * compile error until someone decides which it is, instead of silently taking the weaker one.
 */
export type CallerScope = "session" | "owner-data";

export interface CallerGuardsDeps {
	// The sole resolver of "what must a caller prove to act as X". Absent when tests skip auth.
	auth?: SessionAuthority;
	store: Pick<PendingJobStore<ResponsePayload>, "askerOf">;
}

export type CallerGuards = ReturnType<typeof createCallerGuards>;

export function createCallerGuards({ auth, store }: CallerGuardsDeps) {
	/**
	 * Has this caller proved it is one of THIS gateway's own sessions?
	 *
	 * The question every owner-scoped door asks, since a session NAME proves nothing on its own: an
	 * unregistered name resolves to UNBOUND, which anything satisfies (see CallerScope). True while
	 * no session is bound at all, matching the byte plane's own posture - a gateway with no
	 * credential to demand cannot demand one without refusing every legitimate caller it has.
	 */
	function provedLocalSession(req: Request): boolean {
		return !auth || auth.mayUseLocalPlane(presentedByRequest(req));
	}

	/**
	 * 403 when a caller names a sender it cannot prove it is.
	 *
	 * `from` is stamped verbatim onto the message the recipient reads, so a name this gate cannot
	 * resolve is refused rather than waved through: a near-miss spelling (a trailing space, a
	 * differing case) renders identically to the victim's name at the far end while resolving to no
	 * record here. The only names that pass unproven are ones that resolve to a local session with
	 * no armed binding, which is what keeps hand-launched sessions and a purged store working.
	 */
	function refuseImpersonation(req: Request, claimed: string, scope: CallerScope): Response | null {
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

	/**
	 * 403 when someone other than the session a job is addressed to tries to answer it.
	 *
	 * A job addressed to a REMOTE session is refused outright: a remote team's reply only ever
	 * arrives over the sealed response_push relay, never over local HTTP, so nothing legitimate
	 * needs this door.
	 */
	function refuseForeignReply(req: Request, target: string): Response | null {
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

	/**
	 * 403 when someone other than the session that asked tries to read a job's answer. Mirror of
	 * `refuseForeignReply`, which decides who may answer one.
	 *
	 * A remote asker collects over the sealed response_push relay, never over local HTTP, so its job
	 * is refused here outright.
	 */
	function refuseForeignPoll(req: Request, sessionId: string): Response | null {
		if (!auth) return null;
		const asker = store.askerOf(sessionId);
		// An unknown id is the caller's own 404 to receive, not a refusal.
		if (asker === undefined) return null;
		const key = auth.localTeamKey(asker);
		if (key === null) {
			console.warn(`[auth] refused a local poll of a job asked by "${asker}", which is not a local session`);
			return jsonResponse({ error: "this job's answer is not collected over local HTTP" }, 403);
		}
		if (auth.satisfies(auth.toActFor(key), presentedByRequest(req))) return null;
		// The SAME body and status an id that names nothing gets: an unproven caller must not be able.
		console.warn(`[auth] refused a poll of a job asked by "${asker}" from another session`);
		return jsonResponse({ error: `No pending job for session_id "${sessionId}"` }, 404);
	}

	return { provedLocalSession, refuseImpersonation, refuseForeignReply, refuseForeignPoll };
}
