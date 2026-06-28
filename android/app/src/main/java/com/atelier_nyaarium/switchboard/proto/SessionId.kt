package com.atelier_nyaarium.switchboard.proto

/**
 * Unified address grammar: one dot-delimited path `domain.gateway.spawn.session`, one slug
 * validator, and the conversation axis as a struct field (never a path segment).
 *
 * Hand-authored twin of src/shared/session-id.ts, kept equivalent by the shared vectors in
 * tests/fixtures/session-id/vectors.json (read by both runtimes). The grammar constants live in
 * Protocol (codegen'd) so the separator/tags/slug pattern have one source. See the TS file for the
 * design rationale.
 */

private val SLUG_REGEX = Regex(Protocol.SLUG_PATTERN)

/** The one segment validator: lowercase alnum, internal/trailing hyphen, no leading hyphen. */
fun isSlug(s: String): Boolean = s.isNotEmpty() && s.length <= Protocol.MAX_SLUG_LEN && SLUG_REGEX.matches(s)

fun assertSlug(s: String) {
	if (!isSlug(s)) throw IllegalArgumentException("invalid address segment \"$s\"")
}

/** A conversationId is the slug charset but a looser length (a key component, not a tmux name). */
private fun isConvId(s: String): Boolean = s.isNotEmpty() && s.length <= Protocol.MAX_CONV_ID_LEN && SLUG_REGEX.matches(s)

/** Domain segment for an address minted before enrollment learns the real Domain id. */
const val LOCAL_DOMAIN_SENTINEL = "local"

////////////////////////////////
//  Local team-field codec
//
//  A local team name is the registry/tmux field: a bare `spawn` (a spawn-point) or `spawn.session`
//  (a chat). Distinct from the fully-qualified Address; the wire/store grammar is the Address.

/** A local team field split into its project (spawn) and session segments. */
data class ParsedSessionName(val project: String, val session: String)

/** Split a local team field into (project=spawn, session). The dotless-slug grammar means at most
 * one separator, so the split is unambiguous; a bare name resolves to DEFAULT_SESSION. */
fun parseSessionName(localName: String): ParsedSessionName {
	val i = localName.indexOf(Protocol.ADDRESS_SEP)
	if (i == -1) return ParsedSessionName(localName, Protocol.DEFAULT_SESSION)
	return ParsedSessionName(localName.substring(0, i), localName.substring(i + Protocol.ADDRESS_SEP.length))
}

/** Join a (project, session) into the local team field `project.session`. */
fun composeSessionName(project: String, session: String): String = "$project${Protocol.ADDRESS_SEP}$session"

/** Whether a local team field carries a session segment (a chat, arity 2) vs a bare spawn-point. */
fun isComposite(name: String): Boolean = name.contains(Protocol.ADDRESS_SEP)

////////////////////////////////
//  Value objects

/** A parsed wire target: either an addressable chat (Address) or a non-addressable spawn-point. */
sealed interface Target {
	val canonical: String
}

/** A chat target: the fully-qualified `domain.gateway.spawn.session` address (arity 4). */
class Address private constructor(
	val domain: String,
	val gateway: String,
	val spawn: String,
	val session: String,
) : Target {
	companion object {
		fun of(domain: String, gateway: String, spawn: String, session: String): Address {
			assertSlug(domain)
			assertSlug(gateway)
			assertSlug(spawn)
			assertSlug(session)
			return Address(domain, gateway, spawn, session)
		}

		/** A local target; a blank local domain (arming mode) resolves to the sentinel. */
		fun local(localDomain: String, localGateway: String, spawn: String, session: String): Address =
			of(localDomain.ifEmpty { LOCAL_DOMAIN_SENTINEL }, localGateway, spawn, session)

		/** A cross-gateway/cross-domain target where the DESTINATION's domain is known. */
		fun remote(domain: String, gateway: String, spawn: String, session: String): Address =
			of(domain, gateway, spawn, session)
	}

	override val canonical: String
		get() = listOf(domain, gateway, spawn, session).joinToString(Protocol.ADDRESS_SEP)

	val spawnPoint: SpawnPoint get() = SpawnPoint.of(domain, gateway, spawn)

	override fun equals(other: Any?): Boolean =
		other is Address && domain == other.domain && gateway == other.gateway && spawn == other.spawn && session == other.session

	override fun hashCode(): Int = listOf(domain, gateway, spawn, session).hashCode()
}

/** A spawn-point: `domain.gateway.spawn` (arity 3), non-addressable (a send fails fast). */
class SpawnPoint private constructor(val domain: String, val gateway: String, val spawn: String) : Target {
	companion object {
		fun of(domain: String, gateway: String, spawn: String): SpawnPoint {
			assertSlug(domain)
			assertSlug(gateway)
			assertSlug(spawn)
			return SpawnPoint(domain, gateway, spawn)
		}
	}

	override val canonical: String get() = listOf(domain, gateway, spawn).joinToString(Protocol.ADDRESS_SEP)

	override fun equals(other: Any?): Boolean =
		other is SpawnPoint && domain == other.domain && gateway == other.gateway && spawn == other.spawn

	override fun hashCode(): Int = listOf(domain, gateway, spawn).hashCode()
}

/** Parse a wire target by ARITY: 1 = local spawn-point, 2 = local chat, 3 = remote spawn-point,
 * 4 = remote chat. Local forms fill (localDomain, localGateway). Injective by construction. */
fun parseTarget(wire: String, localDomain: String, localGateway: String): Target {
	val segs = wire.split(Protocol.ADDRESS_SEP)
	val dom = localDomain.ifEmpty { LOCAL_DOMAIN_SENTINEL }
	return when (segs.size) {
		1 -> SpawnPoint.of(dom, localGateway, segs[0])
		2 -> Address.of(dom, localGateway, segs[0], segs[1])
		3 -> SpawnPoint.of(segs[0], segs[1], segs[2])
		4 -> Address.of(segs[0], segs[1], segs[2], segs[3])
		else -> throw IllegalArgumentException("invalid address arity (${segs.size}) in \"$wire\"")
	}
}

////////////////////////////////
//  Session key (the conversation axis is a struct field, never a path segment)

sealed class SessionKey {
	data class Conv(val conversationId: String, val address: Address) : SessionKey()

	data class Notice(val sender: Address) : SessionKey()
}

/** The ONE producer of the flattened store-key string (the opaque wire session_id). */
fun storeKey(k: SessionKey): String = when (k) {
	is SessionKey.Conv ->
		listOf(Protocol.CONV_TAG, k.conversationId, k.address.domain, k.address.gateway, k.address.spawn, k.address.session)
			.joinToString(Protocol.ADDRESS_SEP)
	is SessionKey.Notice ->
		listOf(Protocol.NOTICE_TAG, k.sender.domain, k.sender.gateway, k.sender.spawn, k.sender.session)
			.joinToString(Protocol.ADDRESS_SEP)
}

/** Inverse of [storeKey], or null if the string is not a valid key. The position-0 tag selects the
 * variant and arity is fixed per variant, so a crafted multi-segment id fails the check. */
fun parseStoreKey(s: String): SessionKey? {
	val segs = s.split(Protocol.ADDRESS_SEP)
	if (segs.size == 6 && segs[0] == Protocol.CONV_TAG) {
		val conversationId = segs[1]
		val domain = segs[2]
		val gateway = segs[3]
		val spawn = segs[4]
		val session = segs[5]
		if (!isConvId(conversationId) || !listOf(domain, gateway, spawn, session).all(::isSlug)) return null
		return SessionKey.Conv(conversationId, Address.of(domain, gateway, spawn, session))
	}
	if (segs.size == 5 && segs[0] == Protocol.NOTICE_TAG) {
		val domain = segs[1]
		val gateway = segs[2]
		val spawn = segs[3]
		val session = segs[4]
		if (!listOf(domain, gateway, spawn, session).all(::isSlug)) return null
		return SessionKey.Notice(Address.of(domain, gateway, spawn, session))
	}
	return null
}
