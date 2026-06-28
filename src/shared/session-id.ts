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

////////////////////////////////
//  Unified address grammar (network-addressing migration)
//
//  The target end-state: ONE dot-delimited path `domain.gateway.spawn.session`, ONE slug validator,
//  and the conversation axis as a struct field (never a path segment). Added alongside the legacy
//  TeamAddress/SessionId/NoticeId during the migration; callers move over slice by slice, then the
//  legacy forms and their `/`/`:`-delimited grammar are deleted at the wire flip.

/** The one structural separator for every address/store/thread key. */
export const ADDRESS_SEP = ".";

/** The one segment validator: lowercase alnum, internal/trailing hyphen, no leading hyphen, and no
 * `.`/`/`/`:`. Domain ids (lowercase hex) are a strict subset. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SLUG_LEN = 64;
export function isSlug(s: string): boolean {
	return s.length >= 1 && s.length <= MAX_SLUG_LEN && SLUG_RE.test(s);
}
export function assertSlug(s: string): void {
	if (!isSlug(s)) throw new Error(`invalid address segment "${s}"`);
}

/** A conversationId is the slug charset but a looser length (it is a key component, not a tmux name). */
export const MAX_CONV_ID_LEN = 128;
function isConvId(s: string): boolean {
	return s.length >= 1 && s.length <= MAX_CONV_ID_LEN && SLUG_RE.test(s);
}

/** Domain segment for an address minted before enrollment learns the real Domain id. A real domain
 * id is lowercase hex, so this sentinel never collides. */
export const LOCAL_DOMAIN_SENTINEL = "local";

/** A chat target: the fully-qualified `domain.gateway.spawn.session` address (arity 4). */
export class Address {
	private constructor(
		readonly domain: string,
		readonly gateway: string,
		readonly spawn: string,
		readonly session: string,
	) {}

	static of(domain: string, gateway: string, spawn: string, session: string): Address {
		assertSlug(domain);
		assertSlug(gateway);
		assertSlug(spawn);
		assertSlug(session);
		return new Address(domain, gateway, spawn, session);
	}

	/** A local target; a null/empty local domain (arming mode) resolves to the sentinel. */
	static local(localDomain: string, localGateway: string, spawn: string, session: string): Address {
		return Address.of(localDomain || LOCAL_DOMAIN_SENTINEL, localGateway, spawn, session);
	}

	/** A cross-gateway/cross-domain target where the DESTINATION's domain is known. */
	static remote(domain: string, gateway: string, spawn: string, session: string): Address {
		return Address.of(domain, gateway, spawn, session);
	}

	get canonical(): string {
		return [this.domain, this.gateway, this.spawn, this.session].join(ADDRESS_SEP);
	}

	get spawnPoint(): SpawnPoint {
		return SpawnPoint.of(this.domain, this.gateway, this.spawn);
	}

	equals(o: Address): boolean {
		return (
			this.domain === o.domain &&
			this.gateway === o.gateway &&
			this.spawn === o.spawn &&
			this.session === o.session
		);
	}
}

/** A spawn-point: `domain.gateway.spawn` (arity 3), non-addressable (a send fails fast). */
export class SpawnPoint {
	private constructor(
		readonly domain: string,
		readonly gateway: string,
		readonly spawn: string,
	) {}

	static of(domain: string, gateway: string, spawn: string): SpawnPoint {
		assertSlug(domain);
		assertSlug(gateway);
		assertSlug(spawn);
		return new SpawnPoint(domain, gateway, spawn);
	}

	get canonical(): string {
		return [this.domain, this.gateway, this.spawn].join(ADDRESS_SEP);
	}

	equals(o: SpawnPoint): boolean {
		return this.domain === o.domain && this.gateway === o.gateway && this.spawn === o.spawn;
	}
}

/** Parse a wire target by ARITY: 1 = local spawn-point, 2 = local chat, 3 = remote spawn-point,
 * 4 = remote chat. Local forms fill (localDomain, localGateway). Injective by construction (dotless
 * segments, fixed arity); send/console paths branch on the returned type for the spawn-point fail-fast. */
export function parseTarget(wire: string, localDomain: string, localGateway: string): Address | SpawnPoint {
	const segs = wire.split(ADDRESS_SEP);
	const dom = localDomain || LOCAL_DOMAIN_SENTINEL;
	switch (segs.length) {
		case 1:
			return SpawnPoint.of(dom, localGateway, segs[0]);
		case 2:
			return Address.of(dom, localGateway, segs[0], segs[1]);
		case 3:
			return SpawnPoint.of(segs[0], segs[1], segs[2]);
		case 4:
			return Address.of(segs[0], segs[1], segs[2], segs[3]);
		default:
			throw new Error(`invalid address arity (${segs.length}) in "${wire}"`);
	}
}

/** A channel job key. The conversation axis is a struct field, never a path segment. */
export type SessionKey =
	| { kind: "conv"; conversationId: string; address: Address }
	| { kind: "notice"; sender: Address };

const CONV_TAG = "conv";
const NOTICE_TAG = "notice";

/** The ONE producer of the flattened store-key string (the opaque wire session_id the agent echoes). */
export function storeKey(k: SessionKey): string {
	if (k.kind === "conv") {
		const a = k.address;
		return [CONV_TAG, k.conversationId, a.domain, a.gateway, a.spawn, a.session].join(ADDRESS_SEP);
	}
	const a = k.sender;
	return [NOTICE_TAG, a.domain, a.gateway, a.spawn, a.session].join(ADDRESS_SEP);
}

/** Inverse of `storeKey`, or null if the string is not a valid key. Injective: the position-0 tag
 * selects the variant and arity is fixed per variant, so a crafted multi-segment id fails the check. */
export function parseStoreKey(s: string): SessionKey | null {
	const segs = s.split(ADDRESS_SEP);
	if (segs[0] === CONV_TAG && segs.length === 6) {
		const [, conversationId, domain, gateway, spawn, session] = segs;
		if (!isConvId(conversationId) || ![domain, gateway, spawn, session].every(isSlug)) return null;
		return { kind: "conv", conversationId, address: Address.of(domain, gateway, spawn, session) };
	}
	if (segs[0] === NOTICE_TAG && segs.length === 5) {
		const [, domain, gateway, spawn, session] = segs;
		if (![domain, gateway, spawn, session].every(isSlug)) return null;
		return { kind: "notice", sender: Address.of(domain, gateway, spawn, session) };
	}
	return null;
}
