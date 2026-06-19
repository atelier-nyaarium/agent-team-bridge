////////////////////////////////
//  Session identity value objects
//
//  The single canonical form for a team address and a channel/notice session id.
//  Identity used to be a raw string assembled and torn apart by a dozen ad-hoc
//  builders (composeConvSessionId, deriveChannelJobId, qualifyTeam, teamFromSession,
//  ...), so the same logical session could wear two unequal strings (`9cb5b9` and
//  `switchboard/9cb5b9`) and different stores keyed by different ones. These types
//  own the ONE canonical string, so a store key and a lookup key are the same value
//  by construction, not by two builders happening to agree.
//
//  Boundary rule: a BARE wire name resolves to the local Gateway AT the boundary
//  (`parse`/`local`), never stored bare. An explicit, possibly-remote Gateway id is KEPT
//  (`remote`, and `parse` of an already-qualified string) so cross-Gateway session ids
//  stay byte-stable across two gateways with different local Gateway ids.
//
//  The Kotlin twin lives at android/.../proto/SessionId.kt; the two are kept
//  equivalent by the shared vectors in tests/fixtures/session-id/vectors.json,
//  read by both runtimes. This module OWNS the session-id grammar constants below;
//  console-protocol.ts re-exports them for its wire helpers, and codegen emits them
//  into Protocol.kt (the Kotlin twin reads them from there).

////////////////////////////////
//  Grammar constants

/** Session-id prefix for channel conversations; the target team is the tail after the LAST colon. */
export const CONV_SESSION_PREFIX = "conv:";

/** Session-id prefix for broadcast notices; the sender follows it. */
export const NOTICE_SESSION_PREFIX = "notice:";

/** Separator in a gateway-qualified name (gatewayId then local name); the FIRST one splits Gateway id from local name. */
export const GATEWAY_QUALIFIER_SEP = "/";

////////////////////////////////
//  Class: TeamAddress

/** A team's address: an explicit Gateway id plus a local name. */
export class TeamAddress {
	private constructor(
		readonly gatewayId: string,
		readonly name: string,
	) {}

	/** A local team. A bare name resolves to localGatewayId; an already-qualified
	 * name keeps its (possibly remote) Gateway id. Idempotent, like the old qualifyTeam. */
	static local(localGatewayId: string, name: string): TeamAddress {
		return TeamAddress.parse(name, localGatewayId);
	}

	/** An explicit, possibly-remote Gateway id. The Gateway id is NOT re-resolved to
	 * local; used for a cross-Gateway target where the destination Gateway is known. */
	static remote(gatewayId: string, name: string): TeamAddress {
		return new TeamAddress(gatewayId, name);
	}

	/** Parse a wire team string. The FIRST separator splits Gateway id from name; a bare
	 * name (no separator) resolves to localGatewayId. An explicit Gateway id is preserved. */
	static parse(team: string, localGatewayId: string): TeamAddress {
		const i = team.indexOf(GATEWAY_QUALIFIER_SEP);
		if (i === -1) return new TeamAddress(localGatewayId, team);
		// `i + SEP.length` (not a hardcoded `+ 1`) so the twin stays equivalent if the
		// separator ever changes; the Kotlin side already splits this way.
		return new TeamAddress(team.slice(0, i), team.slice(i + GATEWAY_QUALIFIER_SEP.length));
	}

	/** The one canonical string form: gatewayId + SEP + name. */
	get canonical(): string {
		return `${this.gatewayId}${GATEWAY_QUALIFIER_SEP}${this.name}`;
	}

	equals(other: TeamAddress): boolean {
		return this.gatewayId === other.gatewayId && this.name === other.name;
	}
}

////////////////////////////////
//  Class: SessionId

/** A channel session: a conversation id paired with the target team address. */
export class SessionId {
	private constructor(
		readonly conversationId: string,
		readonly target: TeamAddress,
	) {}

	static channel(conversationId: string, target: TeamAddress): SessionId {
		return new SessionId(conversationId, target);
	}

	/** Parse a channel session id, or null if it is not one (a notice, a CLI uuid,
	 * etc.). The conversation id is everything between the `conv:` prefix and the
	 * LAST colon; the tail is the target team (conversation ids and team names
	 * never contain a colon). An already-qualified target keeps its Gateway id. */
	static parse(wire: string, localGatewayId: string): SessionId | null {
		if (!wire.startsWith(CONV_SESSION_PREFIX)) return null;
		const lastColon = wire.lastIndexOf(":");
		// Need a second colon after the `conv:` prefix to separate conv id from team.
		if (lastColon < CONV_SESSION_PREFIX.length) return null;
		const conversationId = wire.slice(CONV_SESSION_PREFIX.length, lastColon);
		const team = wire.slice(lastColon + 1);
		// A conversation id and a team name never contain a colon, so a third colon
		// means a crafted/malformed id: reject it rather than mis-split (the conv id
		// would otherwise absorb the extra colon). This keeps parse injective on the
		// legal alphabet, so an untrusted respond id cannot alias another session's key.
		if (conversationId.length === 0 || team.length === 0 || conversationId.includes(":")) return null;
		return new SessionId(conversationId, TeamAddress.parse(team, localGatewayId));
	}

	/** The ONLY producer of the `conv:...` wire/store string. */
	get key(): string {
		return `${CONV_SESSION_PREFIX}${this.conversationId}:${this.target.canonical}`;
	}

	equals(other: SessionId): boolean {
		return this.conversationId === other.conversationId && this.target.equals(other.target);
	}
}

////////////////////////////////
//  Class: NoticeId

/** A broadcast notice session id, scoped to its sender. Never respondable, so it
 * has no conversation; the console threads the notice under the sender. */
export class NoticeId {
	private constructor(readonly sender: TeamAddress) {}

	static of(sender: TeamAddress): NoticeId {
		return new NoticeId(sender);
	}

	/** Parse a notice session id, or null if it is not one. */
	static parse(wire: string, localGatewayId: string): NoticeId | null {
		if (!wire.startsWith(NOTICE_SESSION_PREFIX)) return null;
		const sender = wire.slice(NOTICE_SESSION_PREFIX.length);
		if (sender.length === 0) return null;
		return new NoticeId(TeamAddress.parse(sender, localGatewayId));
	}

	get key(): string {
		return `${NOTICE_SESSION_PREFIX}${this.sender.canonical}`;
	}

	equals(other: NoticeId): boolean {
		return this.sender.equals(other.sender);
	}
}
