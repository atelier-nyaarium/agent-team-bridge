package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.LOCAL_DOMAIN_SENTINEL
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import com.atelier_nyaarium.switchboard.proto.parseTarget

////////////////////////////////
//  Interfaces & Types

/** UI model for the sessions board. Mapped from the wire TeamInfo in `teams()`, and also
 * constructed locally for ended threads whose team has left the bridge (a state that never
 * exists on the wire). `name` is the canonical address key (`domain.gateway.spawn.session`, or
 * `domain.gateway.spawn` for a spawn-point); `shortName` and `gatewayId` derive from it. */
data class Team(
	val name: String,
	val status: String,
	val mode: String,
	val queueDepth: Int,
	val kind: String = "loose",
	// Plugin version the agent's MCP process reported. Null for consoles, offline catalog
	// entries, and gateways without the feature. The board shows it only when it differs
	// from this app's own expected version.
	val version: String? = null,
	// The owning Gateway's Domain id, kept a separate field rather than folded into the canonical
	// address. A gateway id is unique only within a Domain, so the board groups by the
	// (domainId, gatewayId) pair. Null for a pre-federation Gateway and for the
	// locally-synthesized ended session.
	val domainId: String? = null,
	// The owning Domain's display name, stamped by the gateway's discover. The Peers list shows
	// this instead of the opaque domainId. Null for a gateway without the feature or a Domain
	// that has not set a name yet.
	val displayName: String? = null,
	// True when the owning Domain is the admin's own, from the register reply via the gateway.
	// The local session's value gates the admin surfaces.
	val isAdminDomain: Boolean = false,
	// The gateway-authoritative free-form label the board renders for this session. Distinct from
	// displayName (the owning Domain's network name). Null for a spawn-point, a session with no
	// record, or an older gateway that does not send it (the app falls back to a local label / leaf).
	val sessionLabel: String? = null,
	// Daemon-derived working/needs-login, from the presence plane (2-frame-hysteresis confirmed
	// server-side). Null means unknown (never observed, or derivation just became impossible), never
	// false - a tile shows no pulse rather than a stale frozen one. Distinct from
	// sessionWorking/sessionNeedsLogin, which back the terminal's own peek and still drive its
	// local frame directly.
	val working: Boolean? = null,
	val needsLogin: Boolean? = null,
	// The session is holding an unanswered usage-limit dialog and cannot progress until it is
	// answered. limitDetail is the text after the headline's middle dot ("resets 5pm"), null when that
	// headline carried no dot, so a blocked session still renders as blocked without one.
	val limitBlocked: Boolean? = null,
	val limitDetail: String? = null,
	// Same-Domain federation freshness for a peer-gateway-sourced row; null for a local row (not a
	// fourth "local" value - the field simply carries no federation freshness concept for one).
	val presenceFresh: String? = null,
) {
	/** Short local field shown in the UI: `spawn` or `spawn.session` from the canonical address. */
	val shortName: String get() = localFieldOf(name)

	/** Owning Gateway id (the gateway segment of the canonical address). */
	val gatewayId: String get() = gatewayOf(name)

	/** A live socket serves this session: confirmed online, or verifying its handshake (connected
	 * but the LLM has not re-answered, e.g. across a gateway restart). Both count as awake. */
	val isLive: Boolean get() = status == "online" || status == "verifying"
}

////////////////////////////////
//  Functions & Helpers

/** The local team field (`spawn` or `spawn.session`) of a canonical address string, for the UI's
 * short labels and the board's spawn-point nesting. A SpawnPoint (arity 3) yields its bare spawn; an
 * Address (arity 4) yields `spawn.session`. */
internal fun localFieldOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> composeSessionName(t.spawn, t.session)
		is SpawnPoint -> t.spawn
	}

/** [localFieldOf] for a value that may ALREADY be a local field rather than a canonical address.
 * `parseTarget` throws on one, and the board holds both forms: its entries store the local field
 * while a chat's `Team.name` is the address. Idempotent, which is what lets a caller apply it
 * without first knowing which form it was handed. */
internal fun localFieldOrSelf(value: String): String = runCatching { localFieldOf(value) }.getOrDefault(value)

/** The Gateway segment of a canonical address string. */
internal fun gatewayOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> t.gateway
		is SpawnPoint -> t.gateway
	}

/** A list_teams answer with its own completeness. Null coverage (an older gateway) claims nothing. */
internal data class TeamsAnswer(val teams: List<Team>, val coverage: DiscoverCoverage? = null)

/** Merge a fresh presence answer over the prior rows, keeping prior rows the answer does not speak
 * for. Fresh wins on a name collision. Pure, so the two merge policies (plane push, discovery with
 * coverage) share one rule and stay testable. */
internal fun mergePresence(prior: List<Team>, fresh: List<Team>, keepPrior: (Team) -> Boolean): List<Team> {
	val freshNames = fresh.mapTo(HashSet()) { it.name }
	return fresh + prior.filter { it.name !in freshNames && keepPrior(it) }
}

/** The carry-forward keys a coverage names: bare gateway ids plus "domainId/gatewayId" peer keys. */
internal fun unreachableKeys(coverage: DiscoverCoverage?): Set<String> =
	((coverage?.unreachable ?: emptyList()) + (coverage?.unreachablePeers ?: emptyList())).toSet()

/** Whether a row belongs to a gateway the answer could not reach (so its rows must be held, not
 * swept as absent). */
internal fun rowOnUnreachable(row: Team, keys: Set<String>, localGatewayId: String): Boolean {
	val gw = row.gatewayId.ifEmpty { localGatewayId }
	return gw in keys || "${row.domainId.orEmpty()}/$gw" in keys
}

/** The one TeamInfo -> Team mapper, shared by the legacy `teams()` list_teams relay AND the
 * presence-plane piggyback on a poll response - both carry the identical wire shape, so mapping
 * it once here means the two paths can never quietly drift onto different Team shapes. */
internal fun teamInfoToTeam(it: TeamInfo, localGatewayId: String): Team {
	val gatewayId = it.gatewayId.ifEmpty { localGatewayId }
	// Mirror the gateway's address minting: a spawn-point (kind devcontainer) is the
	// non-addressable `domain.gateway.spawn` (arity 3); every chat is the full
	// `domain.gateway.spawn.session` (arity 4), a bare team field defaulting its session to
	// DEFAULT_SESSION exactly as the gateway's localAddress does, so a chat's Team.name is
	// byte-equal to the address a session_id carries (no thread/team join mismatch).
	val domain = it.domainId?.ifEmpty { null } ?: LOCAL_DOMAIN_SENTINEL
	val parsed = parseSessionName(it.team)
	val canonicalName = if (it.kind == "devcontainer") {
		SpawnPoint.of(domain, gatewayId, parsed.project).canonical
	} else {
		Address.of(domain, gatewayId, parsed.project, parsed.session).canonical
	}
	return Team(
		name = canonicalName,
		status = it.status,
		mode = it.mode ?: "",
		queueDepth = it.queue_depth.toInt(),
		kind = it.kind,
		version = it.version,
		domainId = it.domainId,
		displayName = it.displayName,
		isAdminDomain = it.isAdminDomain ?: false,
		sessionLabel = it.sessionLabel,
		working = it.working,
		needsLogin = it.needsLogin,
		limitBlocked = it.limitBlocked,
		limitDetail = it.limitDetail,
		presenceFresh = it.presenceFresh,
	)
}
