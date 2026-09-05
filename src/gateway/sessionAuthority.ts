import crypto from "node:crypto";
import { Address, composeSessionName, DEFAULT_SESSION, parseTarget } from "../shared/session-id.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
// Type-only: websocket.ts imports the gates from here, so a value import either way would close a
// runtime cycle. The one function needed from that module is injected instead.
import type { TeamRegistry, WsData } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

/**
 * What a caller must prove in order to act as some subject, as resolved by this module.
 *
 * The whole point of the type is that UNBOUND is a VALUE a resolver decided on, never an absence
 * a caller arrived at by falling off the end of its own derivation. A hand-written gate that falls
 * off the end of its own derivation defaults to "no expectation, therefore allow", so an incomplete
 * derivation silently means ALLOW. Being opaque, this type cannot be constructed at a call site, so
 * a gate can no longer manufacture an accidental permit that way.
 */
export interface SessionBinding {
	readonly token: string | null;
	readonly __sessionBinding: true;
}

/** What a caller actually presented, over whichever channel it arrived on. One type for all of
 * them, so a future channel adds a reader here instead of another secret-shaped string at a gate. */
export interface Presented {
	readonly token: string | null;
	readonly __presented: true;
}

export interface SessionAuthorityDeps {
	sessionStore?: SessionStore;
	registry: TeamRegistry;
	/** Injected rather than imported: websocket.ts consumes the gates defined here, so importing its
	 * resolver back would close a runtime cycle. */
	resolveLive: (
		registry: TeamRegistry,
		sessionStore: SessionStore | undefined,
		team: string,
	) => { data: WsData } | undefined;
	localDomainId: () => string;
	localGatewayId: string;
}

export interface SessionAuthority {
	/**
	 * NAME-keyed: who owns this team key right now, or UNBOUND if nobody does.
	 *
	 * Inert-awareness lives here and ONLY here. A token minted for a launch that merely reattached
	 * to a live pane was never delivered (the launch command, and its export, is discarded), so
	 * demanding it would strand the very session it names. Callers cannot forget this rule because
	 * they cannot see the token to check it themselves.
	 */
	toClaim(teamKey: string): SessionBinding;

	/**
	 * Whether a presented credential IS this exact team's launch token, answered without consulting
	 * whether the binding has been activated yet.
	 *
	 * Deliberately not `toClaim`: that hides an inert binding as UNBOUND so a reattached pane is not
	 * stranded, which makes "no record at all" and "record whose token has never been presented"
	 * indistinguishable. A daemon-launched session presents its token on its FIRST registration,
	 * before activation, so a gate built on `toClaim` would refuse every real host session.
	 */
	presentsOwnLaunchToken(teamKey: string, got: Presented): boolean;

	/**
	 * SOCKET-keyed: who may answer for the session on this socket.
	 *
	 * Deliberately not derived from the record. A `claude --resume` incarnation legitimately serves
	 * a bound record while registered under its own unbound name and holding no token, so the
	 * socket is the subject. Deliberately not inert-aware either: the register gate already ensures
	 * a socket only carries a token it proved, so inertness is settled before this is ever asked.
	 */
	toAnswerFor(ws: { data: WsData } | undefined): SessionBinding;

	/**
	 * The composition: who may act for whatever session serves this team key, awake or asleep.
	 *
	 * Live-first for the alias case above, with a record fallback because asleep is a session's
	 * normal state and the easiest moment to forge into. Named rather than re-derived at each site:
	 * getting either half of this precedence wrong at a new call site would silently reopen the
	 * forgery window this module exists to close.
	 */
	toActFor(teamKey: string): SessionBinding;

	/**
	 * The local record key a caller-supplied name refers to, or null when it names nothing local.
	 *
	 * Arity-aware exactly as delivery is, so every spelling that reaches a session resolves to the
	 * same subject: a bare spawn-point names no session, a `spawn.session` pair does, and the
	 * 4-segment canonical form does too when its domain and gateway are ours. Null means "this does
	 * not name a local session", which a gate must treat as a refusal rather than as permission,
	 * since an unparseable name is still stamped verbatim onto the message the recipient sees.
	 */
	localTeamKey(name: string): string | null;

	/** Does this presentation satisfy the requirement? UNBOUND is satisfied by anything; a bound
	 * requirement only by an exact match, so a missing presentation is a refusal and never a
	 * fallback. */
	satisfies(need: SessionBinding, got: Presented): boolean;

	/**
	 * SUBJECT-less: may this caller use a local plane that belongs to no single session?
	 *
	 * The byte plane is the case that needs it. A blob transfer names bytes, not a session, so there
	 * is no claim to check and none of the three gates above applies - yet those routes write to this
	 * gateway's disk and must not be usable by anything that can reach the port.
	 *
	 * The answer keeps the module's existing shape rather than inventing a stricter one: if ANY local
	 * session is bound, a caller must present one of those tokens; if none is, the requirement is
	 * UNBOUND and anything satisfies it, exactly as `toClaim` on an unbound name already decides. So
	 * this is no weaker than the posture `/send` already takes, and a hand-launched tokenless
	 * deployment keeps working instead of silently losing its attachments.
	 */
	mayUseLocalPlane(got: Presented): boolean;

	/** Are these the same principal? Not satisfaction: UNBOUND equals only UNBOUND. */
	sameAs(a: SessionBinding, b: SessionBinding): boolean;

	/** The confirmed managed session whose active binding a request proves. */
	resolveConfirmedManagedSession(req: Request): SessionRecord | null;
}

////////////////////////////////
//  Functions & Helpers

const UNBOUND: SessionBinding = { token: null, __sessionBinding: true };

/** A caller that presented no credential at all. Exported so a resolver's optional parameter has a
 * real value to default to rather than an absence. */
export const NOTHING_PRESENTED: Presented = { token: null, __presented: true };

function binding(token: string | null | undefined): SessionBinding {
	return token ? { token, __sessionBinding: true } : UNBOUND;
}

function presented(token: string | null | undefined): Presented {
	return token ? { token, __presented: true } : NOTHING_PRESENTED;
}

/** The one reader of the HTTP credential header. An in-process caller passes a synthetic request
 * with no headers and correctly presents nothing. */
export function presentedByRequest(req: Request): Presented {
	return presented(req.headers.get("x-session-token"));
}

/** The credential a register frame carries. */
export function presentedByRegister(reg: { sessionToken?: string }): Presented {
	return presented(reg.sessionToken);
}

/** The credential a socket proved at register time. */
export function presentedBySocket(ws: { data: WsData } | undefined): Presented {
	return presented(ws?.data?.boundToken);
}

/** Constant-time over equal-length secrets; unequal lengths are unequal without a compare. */
function secretsEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return crypto.timingSafeEqual(left, right);
}

export function createSessionAuthority(deps: SessionAuthorityDeps): SessionAuthority {
	const { sessionStore, registry, resolveLive, localDomainId, localGatewayId } = deps;

	function toClaim(teamKey: string): SessionBinding {
		const record = sessionStore?.getByTeam(teamKey);
		if (!record || !sessionStore?.isBindingActive(record)) return UNBOUND;
		return binding(record.bindToken);
	}

	function presentsOwnLaunchToken(teamKey: string, got: Presented): boolean {
		if (!got.token) return false;
		const record = sessionStore?.recordByBindToken(got.token);
		if (!record || !sessionStore) return false;
		return sessionStore.teamOf(record) === teamKey;
	}

	function toAnswerFor(ws: { data: WsData } | undefined): SessionBinding {
		return binding(ws?.data?.boundToken);
	}

	function toActFor(teamKey: string): SessionBinding {
		const live = resolveLive(registry, sessionStore, teamKey);
		return live ? toAnswerFor(live) : toClaim(teamKey);
	}

	function localTeamKey(name: string): string | null {
		let target: ReturnType<typeof parseTarget>;
		try {
			target = parseTarget(name, localDomainId(), localGatewayId);
		} catch {
			return null;
		}
		if (target.domain !== localDomainId() || target.gateway !== localGatewayId) return null;
		// A bare spawn resolves to that spawn's default session, matching how delivery expands the
		// same name, so a gate and a delivery can never disagree about which session a name means.
		return target instanceof Address
			? composeSessionName(target.spawn, target.session)
			: composeSessionName(target.spawn, DEFAULT_SESSION);
	}

	function satisfies(need: SessionBinding, got: Presented): boolean {
		if (!need.token) return true;
		return !!got.token && secretsEqual(need.token, got.token);
	}

	function sameAs(a: SessionBinding, b: SessionBinding): boolean {
		if (!a.token || !b.token) return a.token === b.token;
		return secretsEqual(a.token, b.token);
	}

	function mayUseLocalPlane(got: Presented): boolean {
		const records = Object.values(sessionStore?.snapshot() ?? {});
		// Inert bindings do not count, for the same reason toClaim ignores them: a token minted for a
		// launch that only reattached was never delivered, so demanding it would refuse a session that
		// legitimately holds nothing.
		const bound = records.filter((r) => r.bindToken && sessionStore?.isBindingActive(r as SessionRecord));
		if (bound.length === 0) return true;
		return bound.some((r) => satisfies(binding(r.bindToken), got));
	}

	function resolveConfirmedManagedSession(req: Request): SessionRecord | null {
		if (!sessionStore) return null;
		const got = presentedByRequest(req);
		if (!got.token) return null;
		const record = sessionStore.recordByBindToken(got.token);
		if (!record || !sessionStore.isBindingActive(record) || record.confirmedAt === undefined) return null;
		return satisfies(binding(record.bindToken), got) ? record : null;
	}

	return {
		toClaim,
		presentsOwnLaunchToken,
		toAnswerFor,
		toActFor,
		localTeamKey,
		satisfies,
		sameAs,
		mayUseLocalPlane,
		resolveConfirmedManagedSession,
	};
}
