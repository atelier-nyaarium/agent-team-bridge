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
//  Local team-field codec
//
//  A LOCAL team name is the registry/tmux field: a bare `spawn` (a spawn-point) or `spawn.session`
//  (a chat). It is distinct from the fully-qualified Address below - the wire/store grammar is the
//  Address. Both share the one `ADDRESS_SEP` and the one dotless-slug rule.

/** Session a bare (sessionless) local name resolves to as a wake/UI default. */
export const DEFAULT_SESSION = "claude";

/** Split a local team field into (project=spawn, session). The dotless-slug grammar means at most
 * one separator, so the split is unambiguous; a bare name resolves to DEFAULT_SESSION. */
export function parseSessionName(localName: string): { project: string; session: string } {
	const i = localName.indexOf(ADDRESS_SEP);
	if (i === -1) return { project: localName, session: DEFAULT_SESSION };
	return { project: localName.slice(0, i), session: localName.slice(i + ADDRESS_SEP.length) };
}

/** Join a (project, session) into the local team field `project.session`. */
export function composeSessionName(project: string, session: string): string {
	return `${project}${ADDRESS_SEP}${session}`;
}

/** Whether a local team field carries a session segment (a chat, arity 2) vs a bare spawn-point
 * (arity 1). The register write-guard keeps bare spawn-points out of the chat/resume path. */
export function isComposite(name: string): boolean {
	return name.includes(ADDRESS_SEP);
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

/** Position-0 store-key tags selecting the SessionKey variant. Emitted into the Kotlin twin. */
export const CONV_TAG = "conv";
export const NOTICE_TAG = "notice";

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
