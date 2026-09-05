import type { Ambient } from "../shared/ambient.js";
import type { SessionBinding } from "./sessionAuthority.js";
import { HANDSHAKE_PENDING_TTL_MS, HANDSHAKE_REPUSH_DEDUPE_MS, HANDSHAKE_REPUSH_MAX_ATTEMPTS } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface HandshakePending {
	team: string;
	subId: string;
	sentAt: number;
	repushCount: number;
}

/** A repush decision. "send" carries the wire push and a commit the caller invokes ONLY after the
 * socket send succeeded, so a failed send charges no attempt and moves no throttle window. */
export type RepushDecision =
	| { kind: "no-pending" }
	| { kind: "capped" }
	| { kind: "throttled" }
	| { kind: "send"; hsId: string; push: string; attempt: number; commit: () => void };

////////////////////////////////
//  Class

/**
 * The bridge handshake's state and decisions, with every effect left to the caller: which hs-* id a
 * (team, subId) owes, the repush throttle and attempt rules, and which binding confirmed a team's
 * lead. Sockets, record establishment, eviction and the auth gate stay in the connection layer -
 * this class never sees a socket, which is what makes the rules testable without one.
 */
export class HandshakeGate {
	// Maps handshake session_id -> the socket that owes a lead/worker reply, so we can resolve
	// handshake responses. sentAt/repushCount back repushHandshake's dedupe window and attempt cap.
	// Cleared on close/evict (forget); bounded by the count of live unconfirmed sockets, since
	// mint fires at most once per register and a repush reuses the existing entry.
	private pending = new Map<string, HandshakePending>();

	// Last repush success per TEAM (not per entry): a caller who knows several of one team's
	// sub-session conversationIds could otherwise round-robin across them to land a fresh push
	// every tick, sidestepping the per-entry dedupe window. Keyed by team name - an
	// unauthenticated /bridge register can claim any team-shaped string, so this is swept
	// (see sweep) rather than assumed bounded; an entry past HANDSHAKE_REPUSH_DEDUPE_MS has zero
	// remaining throttling effect, so the sweep is pure cleanup with no behavior change.
	private teamLastRepushAt = new Map<string, number>();

	// Teams that have completed at least one REAL handshake round-trip (a genuine challenge
	// answered via resolveHandshake, not a self-reported register field). A register's own
	// isMainOrLead:true claim is only honored for a team already in this set - otherwise a
	// never-before-seen team could skip the handshake challenge entirely on its first-ever
	// connection by simply asserting the field, with no server-side signal backing it.
	// Keyed by team, VALUED by the binding that confirmed it, so the fast path re-checks identity
	// rather than the bare name: a socket presenting a different binding than the one that answered
	// the real challenge is sent through a fresh handshake instead of inheriting confirmed-lead
	// status. An unbound team stores the UNBOUND value, which a later unbound registrant matches
	// (sameAs: UNBOUND equals only UNBOUND), so a hand-launched session is not re-prompted every
	// reconnect. Held OPAQUELY: only sessionAuthority may read a binding's fields.
	private confirmedLeadTeams = new Map<string, SessionBinding>();

	constructor(private readonly ambient: Pick<Ambient, "now" | "newId">) {}

	private now(): number {
		return this.ambient.now();
	}

	/** The exact wire push for a handshake id, byte-identical whether this is the first send or a
	 * re-push. The MCP's confirm guard (receivedIds, keyed off from==="gateway" && replyJsonSchema)
	 * depends on that identity, so a re-push must carry both fields unchanged. */
	static buildPush(hsSessionId: string): string {
		return JSON.stringify({
			type: "channel_push",
			from: "gateway",
			body: `This is the initial bridge handshake. Reply with the \`channel_reply_structured\` tool using the session_id shown above, setting \`responseData\` to \`{ "isMainOrLead": true }\` if you are the primary session or team lead, or \`{ "isMainOrLead": false }\` if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\`.`,
			session_id: hsSessionId,
			replyJsonSchema: "{ isMainOrLead: bool }",
		});
	}

	/** Structured claims or exact legacy tokens only. */
	static leadClaim(replyAsJson?: Record<string, unknown>, response?: string): boolean | undefined {
		if (replyAsJson && typeof replyAsJson.isMainOrLead === "boolean") return replyAsJson.isMainOrLead;
		const legacy = response?.trim().toLowerCase();
		if (legacy === "true") return true;
		if (legacy === "false") return false;
		return undefined;
	}

	/** Mint a fresh lead handshake for a (team, subId) and return its wire push for the caller to
	 * send. Drops any pending entry already owned by these coordinates first, so a same-socket
	 * re-register can never leave two independently-resolvable entries for the same coordinates. */
	mint(team: string, subId: string): { hsId: string; push: string } {
		this.forget(team, subId);
		const hsId = `hs-${this.ambient.newId().slice(0, 8)}`;
		this.pending.set(hsId, { team, subId, sentAt: this.now(), repushCount: 0 });
		return { hsId, push: HandshakeGate.buildPush(hsId) };
	}

	/** Whether an entry has outlived its BLOCKING window. Expiry ends what the entry may do to
	 * others (block replies, draw repushes), never what its own socket may still do with it: the
	 * challenge's authenticity does not decay with age, so a late answer still confirms - refusing
	 * it would trade the old lockout for a session stuck "verifying" until reconnect. Answered HERE
	 * rather than only in a sweeper: a lockout that self-heals on a 30s heartbeat is a lockout that
	 * does not self-heal at all if the heartbeat is ever rewired. */
	private expired(p: HandshakePending, now: number): boolean {
		return now - p.sentAt >= HANDSHAKE_PENDING_TTL_MS;
	}

	/** The pending hs-* id owed by a (team, subId), if any - so a caller with an unconfirmed socket
	 * of its own can be told exactly which handshake to answer first. An expired entry answers
	 * undefined, which is what lets the reply gate fall through to its fail-open case. */
	pendingIdFor(team: string, subId: string): string | undefined {
		const now = this.now();
		for (const [hsId, p] of this.pending) {
			if (p.team === team && p.subId === subId && !this.expired(p, now)) return hsId;
		}
		return undefined;
	}

	/** The pending entry for an hs-* id, NOT consumed: the caller's auth gate runs between this read
	 * and consume(), so a spoofed answer can be refused without eating the entry the real session
	 * still needs. Deliberately NOT expiry-filtered: this is the answer path, and a late answer must
	 * still confirm (see expired()'s doc) - the map stays bounded by live unconfirmed sockets via
	 * forget() on close, so keeping the entry costs nothing. */
	pendingOf(sessionId: string): HandshakePending | undefined {
		return this.pending.get(sessionId);
	}

	consume(sessionId: string): void {
		this.pending.delete(sessionId);
	}

	/** Drop any pending handshake owned by a (team, subId) - a socket that will never answer. */
	forget(team: string, subId: string): void {
		for (const [hsId, p] of this.pending) {
			if (p.team === team && p.subId === subId) this.pending.delete(hsId);
		}
	}

	/** Whether a (team, subId)'s still-pending handshake may be re-sent right now. Reuses the
	 * EXISTING hs-* id - never mints a second one, which would leak a duplicate pending entry and
	 * defeat the attempt cap. The team-level guard only applies from an entry's SECOND attempt
	 * onward, so several sub-sessions of one team recovering at once each get their one first shot
	 * instead of queuing behind a sibling. */
	decideRepush(team: string, subId: string): RepushDecision {
		const hsId = this.pendingIdFor(team, subId);
		const entry = hsId ? this.pending.get(hsId) : undefined;
		if (!hsId || !entry) return { kind: "no-pending" };
		if (entry.repushCount >= HANDSHAKE_REPUSH_MAX_ATTEMPTS) return { kind: "capped" };
		const now = this.now();
		// Always applies, even on a first attempt: collapses a same-instant double-trigger on THIS
		// entry (e.g. an immediate repush landing right after mint's own send).
		if (now - entry.sentAt < HANDSHAKE_REPUSH_DEDUPE_MS) return { kind: "throttled" };
		if (entry.repushCount > 0) {
			const teamLast = this.teamLastRepushAt.get(team);
			if (teamLast !== undefined && now - teamLast < HANDSHAKE_REPUSH_DEDUPE_MS) return { kind: "throttled" };
		}
		return {
			kind: "send",
			hsId,
			push: HandshakeGate.buildPush(hsId),
			attempt: entry.repushCount + 1,
			commit: () => {
				entry.sentAt = now;
				entry.repushCount += 1;
				this.teamLastRepushAt.set(team, now);
			},
		};
	}

	/** Record which binding answered a team's real challenge; confirmedBy serves the fast path. */
	confirmLead(team: string, binding: SessionBinding): void {
		this.confirmedLeadTeams.set(team, binding);
	}

	confirmedBy(team: string): SessionBinding | undefined {
		return this.confirmedLeadTeams.get(team);
	}

	/** Pure cleanup: a throttle entry past its dedupe window no longer throttles anything, and
	 * teamLastRepushAt needs the bound (an unauthenticated register can mint unbounded team names).
	 * `pending` is deliberately NOT swept - an expired entry no longer blocks or repushes, but its
	 * own socket may still answer it (see pendingOf), and the map is already bounded by live
	 * unconfirmed sockets via forget() on close. Returns how many entries were dropped, which is
	 * the boundedness contract a test can hold. */
	sweep(): number {
		const now = this.now();
		let dropped = 0;
		for (const [team, lastAt] of this.teamLastRepushAt) {
			if (now - lastAt >= HANDSHAKE_REPUSH_DEDUPE_MS) {
				this.teamLastRepushAt.delete(team);
				dropped += 1;
			}
		}
		return dropped;
	}

	/** Close sockets past the handshake deadline. */
	expirePending(): HandshakePending[] {
		const now = this.now();
		const expired: HandshakePending[] = [];
		for (const [hsId, pending] of this.pending) {
			if (!this.expired(pending, now)) continue;
			expired.push(pending);
			this.pending.delete(hsId);
		}
		return expired;
	}
}
