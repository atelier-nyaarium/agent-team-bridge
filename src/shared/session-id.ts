////////////////////////////////
//  Session identity value objects
//
//  The single canonical form for a team address and a channel/notice session id.
//  These types own the ONE canonical string, so a store key and a lookup key are
//  the same value by construction.
//
//  Boundary rule: a bare wire name resolves to the local Gateway at the boundary
//  (`parse`/`local`), never stored bare. An explicit, possibly-remote Gateway id is
//  kept (`remote`, and `parse` of an already-qualified string) so cross-Gateway
//  session ids stay byte-stable across two gateways with different local Gateway ids.
//
//  The Kotlin twin at android/.../proto/SessionId.kt is held equivalent by the shared
//  vectors in tests/fixtures/session-id/vectors.json, read by both runtimes. This
//  module owns the grammar constants below; console-protocol.ts re-exports them and
//  codegen emits them into Protocol.kt.

////////////////////////////////
//  Grammar constants

/** Session-id prefix for channel conversations; the target team is the tail after the LAST colon. */
export const CONV_SESSION_PREFIX = "conv:";

/** Session-id prefix for broadcast notices; the sender follows it. */
export const NOTICE_SESSION_PREFIX = "notice:";

/** Separator in a gateway-qualified name (gatewayId then local name); the FIRST one splits Gateway id from local name. */
export const GATEWAY_QUALIFIER_SEP = "/";

/** Separator in a local terminal name (`project.session`); the LAST one splits the session off, so a dotted project round-trips. Distinct from "/" and ":". */
export const SESSION_SEP = ".";

/** Session a bare (sessionless) local name resolves to. */
export const DEFAULT_SESSION = "claude";

/** Split a local name into its (project, session). The session is a dotless slug, so the LAST
 *  separator splits it off; the project may itself contain the separator. A bare name resolves to
 *  DEFAULT_SESSION. This is a mechanical split: a caller that must distinguish a composite from a
 *  bare-but-dotted project name (a dotted devcontainer dir) checks the catalog on the whole name
 *  first, then falls back to this. */
export function parseSessionName(localName: string): { project: string; session: string } {
	const i = localName.lastIndexOf(SESSION_SEP);
	if (i === -1) return { project: localName, session: DEFAULT_SESSION };
	return { project: localName.slice(0, i), session: localName.slice(i + SESSION_SEP.length) };
}

/** Join a (project, session) into the local name `project<SEP>session`. */
export function composeSessionName(project: string, session: string): string {
	return `${project}${SESSION_SEP}${session}`;
}

/** Whether a local name carries a session segment. A composite is a (loose) session, never the
 * bare project that is the devcontainer catalog/spawn-point entry. */
export function isComposite(name: string): boolean {
	return name.includes(SESSION_SEP);
}

////////////////////////////////
//  Class: TeamAddress

/** A team's address: an explicit Gateway id plus a local name. */
export class TeamAddress {
	private constructor(
		readonly gatewayId: string,
		readonly name: string,
	) {}

	/** A local team. A bare name resolves to localGatewayId; an already-qualified
	 * name keeps its (possibly remote) Gateway id. Idempotent. */
	static local(localGatewayId: string, name: string): TeamAddress {
		return TeamAddress.parse(name, localGatewayId);
	}

	/** An explicit, possibly-remote Gateway id, not re-resolved to local. For a
	 * cross-Gateway target where the destination Gateway is known. */
	static remote(gatewayId: string, name: string): TeamAddress {
		return new TeamAddress(gatewayId, name);
	}

	/** Parse a wire team string. The FIRST separator splits Gateway id from name; a bare
	 * name (no separator) resolves to localGatewayId. An explicit Gateway id is preserved. */
	static parse(team: string, localGatewayId: string): TeamAddress {
		const i = team.indexOf(GATEWAY_QUALIFIER_SEP);
		if (i === -1) return new TeamAddress(localGatewayId, team);
		// Slice by SEP.length, not a hardcoded 1, so the twin stays equivalent if the
		// separator ever changes.
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

	/** Parse a channel session id, or null if it is not one. The conversation id is
	 * everything between the `conv:` prefix and the last colon; the tail is the target
	 * team (conversation ids and team names never contain a colon). */
	static parse(wire: string, localGatewayId: string): SessionId | null {
		if (!wire.startsWith(CONV_SESSION_PREFIX)) return null;
		const lastColon = wire.lastIndexOf(":");
		// Need a second colon after the `conv:` prefix to separate conv id from team.
		if (lastColon < CONV_SESSION_PREFIX.length) return null;
		const conversationId = wire.slice(CONV_SESSION_PREFIX.length, lastColon);
		const team = wire.slice(lastColon + 1);
		// Reject a third colon rather than mis-split: it keeps parse injective on the
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
