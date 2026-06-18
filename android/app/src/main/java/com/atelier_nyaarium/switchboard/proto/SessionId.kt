package com.atelier_nyaarium.switchboard.proto

/**
 * Session identity value objects: the single canonical form for a team address
 * and a channel/notice session id.
 *
 * Hand-authored twin of src/shared/session-id.ts, kept equivalent by the shared
 * vectors in tests/fixtures/session-id/vectors.json (read by both runtimes). The
 * grammar constants live in Protocol (codegen'd) so the separator/prefixes have
 * one source. See the TS file for the design rationale.
 */

/** A team's address: an explicit Gateway id plus a local name. */
class TeamAddress private constructor(val gatewayId: String, val name: String) {
	companion object {
		/** A local team. A bare name resolves to localGatewayId; an already-qualified
		 * name keeps its (possibly remote) Gateway id. Idempotent. */
		fun local(localGatewayId: String, name: String): TeamAddress = parse(name, localGatewayId)

		/** An explicit, possibly-remote Gateway id; NOT re-resolved to local. */
		fun remote(gatewayId: String, name: String): TeamAddress = TeamAddress(gatewayId, name)

		/** Parse a wire team string. The FIRST separator splits Gateway id from name; a
		 * bare name resolves to localGatewayId. An explicit Gateway id is preserved. */
		fun parse(team: String, localGatewayId: String): TeamAddress {
			val i = team.indexOf(Protocol.GATEWAY_QUALIFIER_SEP)
			return if (i == -1) {
				TeamAddress(localGatewayId, team)
			} else {
				TeamAddress(team.substring(0, i), team.substring(i + Protocol.GATEWAY_QUALIFIER_SEP.length))
			}
		}
	}

	/** The one canonical string form: gatewayId + SEP + name. */
	val canonical: String get() = "$gatewayId${Protocol.GATEWAY_QUALIFIER_SEP}$name"

	override fun equals(other: Any?): Boolean = other is TeamAddress && gatewayId == other.gatewayId && name == other.name

	override fun hashCode(): Int = 31 * gatewayId.hashCode() + name.hashCode()
}

/** A channel session: a conversation id paired with the target team address. */
class SessionId private constructor(val conversationId: String, val target: TeamAddress) {
	companion object {
		fun channel(conversationId: String, target: TeamAddress): SessionId = SessionId(conversationId, target)

		/** Parse a channel session id, or null if it is not one. The conversation
		 * id is between the `conv:` prefix and the LAST colon; the tail is the
		 * target team. An already-qualified target keeps its gateway. */
		fun parse(wire: String, localGatewayId: String): SessionId? {
			if (!wire.startsWith(Protocol.CONV_SESSION_PREFIX)) return null
			val lastColon = wire.lastIndexOf(':')
			if (lastColon < Protocol.CONV_SESSION_PREFIX.length) return null
			val conversationId = wire.substring(Protocol.CONV_SESSION_PREFIX.length, lastColon)
			val team = wire.substring(lastColon + 1)
			// A conv id and a team name never contain a colon; a third colon means a
			// crafted/malformed id, so reject it rather than mis-split (mirrors the TS twin).
			if (conversationId.isEmpty() || team.isEmpty() || conversationId.contains(':')) return null
			return SessionId(conversationId, TeamAddress.parse(team, localGatewayId))
		}
	}

	/** The ONLY producer of the `conv:...` wire/store string. */
	val key: String get() = "${Protocol.CONV_SESSION_PREFIX}$conversationId:${target.canonical}"

	override fun equals(other: Any?): Boolean =
		other is SessionId && conversationId == other.conversationId && target == other.target

	override fun hashCode(): Int = 31 * conversationId.hashCode() + target.hashCode()
}

/** A broadcast notice session id, scoped to its sender. No conversation; the console
 * threads the notice under the sender. */
class NoticeId private constructor(val sender: TeamAddress) {
	companion object {
		fun of(sender: TeamAddress): NoticeId = NoticeId(sender)

		/** Parse a notice session id, or null if it is not one. */
		fun parse(wire: String, localGatewayId: String): NoticeId? {
			if (!wire.startsWith(Protocol.NOTICE_SESSION_PREFIX)) return null
			val sender = wire.substring(Protocol.NOTICE_SESSION_PREFIX.length)
			if (sender.isEmpty()) return null
			return NoticeId(TeamAddress.parse(sender, localGatewayId))
		}
	}

	val key: String get() = "${Protocol.NOTICE_SESSION_PREFIX}${sender.canonical}"

	override fun equals(other: Any?): Boolean = other is NoticeId && sender == other.sender

	override fun hashCode(): Int = sender.hashCode()
}
