package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
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
	// Everything a Gateway reports about this session, and what that report is WORTH. Deliberately
	// one value rather than the loose fields it used to be: a bare `status`/`working`/`needsLogin`
	// says nothing about whether it arrived on the pushed presence plane (current) or the 30-second
	// See Presence.kt for the whole reasoning; the status string in there has no accessor on purpose.
	val presence: Presence,
	val kind: String = "loose",
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
	// Same-Domain federation freshness for a peer-gateway-sourced row; null for a local row (not a
	// fourth "local" value - the field simply carries no federation freshness concept for one).
	val presenceFresh: String? = null,
) {
	/** Short local field shown in the UI: `spawn` or `spawn.session` from the canonical address. */
	val shortName: String get() = localFieldOf(name)

	/** Owning Gateway id (the gateway segment of the canonical address). */
	val gatewayId: String get() = gatewayOf(name)

	/** A live socket serves this session. Forwarded rather than reached through `presence` because
	 * it is the single most-read question on the board; everything else goes through [presence] so
	 * the answer arrives with the authority that qualifies it. */
	val isLive: Boolean get() = presence.isLive
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

/** Re-stamp what this row's report is worth. [teamInfoToTeam] stamps POLLED because it serves both
 * delivery channels and cannot tell them apart; only the caller holding the answer knows more. */
internal fun Team.withAuthority(a: Authority): Team = copy(presence = presence.withAuthority(a))

/** Attach this device's own outstanding request for this session, or clear it. */
internal fun Team.withReceipt(r: ActionReceipt?): Team = copy(presence = presence.withReceipt(r))

/** The host spawn points one Gateway offers, keyed the way the console groups sessions. Domain is
 * nullable upstream, so an absent one folds onto the admin Domain exactly as a Team row's does. */
internal fun GatewaySpawnPoints.groupKey(adminDomainId: String): GatewayGroupKey =
	GatewayGroupKey(domainId.orEmpty().ifEmpty { adminDomainId }, gatewayId)

/**
 * The (gateway, project) a spawn target names, for remembering what a Gateway was last spawned on.
 *
 * A BARE target is a project on the home Gateway - that is what bare means everywhere else in this
 * app - so an empty gateway segment resolves to this device's own rather than to nothing. Reading it
 * as nothing is not a small miss: `CreateDialogTarget.targetFor` returns bare for the local Gateway,
 * which is the common case, so it silently disabled remembering entirely for the machine most likely
 * to be spawned on.
 *
 * Null for a target that does not parse, and for a full session address, which names a session
 * rather than a spawn point and is not something the create dialog produces.
 */
internal fun spawnTargetKey(target: String, homeGatewayId: String): Pair<String, String>? {
	if (homeGatewayId.isEmpty()) return null
	// Parsed WITH the local context, not blank context. `parseTarget` throws on a bare local field
	// when it has no Domain and Gateway to qualify it against - which is the whole reason
	// `localFieldOrSelf` exists - so parsing blank silently rejected every bare target, meaning every
	// yet"; only the gateway and spawn are read back out.
	val parsed = runCatching { parseTarget(target, LOCAL_DOMAIN_SENTINEL, homeGatewayId) }.getOrNull() ?: return null
	// A SpawnPoint is what the create dialog builds. An Address names a SESSION, and a project whose
	// own name contains a dot parses as one (arity decides, and nothing here knows the catalog), so
	// such a project is simply not remembered. That degrades to no suggestion, never a wrong one.
	if (parsed !is SpawnPoint || parsed.gateway.isEmpty() || parsed.spawn.isEmpty()) return null
	return parsed.gateway to parsed.spawn
}

/** Merge a fresh presence answer over the prior rows, keeping prior rows the answer does not speak
 * for. Fresh wins on a name collision. Pure, so the two merge policies (plane push, refresh with
 * coverage) share one rule and stay testable. */
internal fun mergePresence(prior: List<Team>, fresh: List<Team>, keepPrior: (Team) -> Boolean): List<Team> {
	val freshNames = fresh.mapTo(HashSet()) { it.name }
	return fresh + prior.filter { it.name !in freshNames && keepPrior(it) }
}

/**
 * Whether a row the last fold held survives a projection that no longer carries it.
 *
 * The roster names every Gateway the projection speaks for, and the Router KEEPS a disconnected
 * Gateway's rows, marking them unreachable rather than dropping them. So an absent row on a named
 * Gateway is a session that is gone, and holding it draws a session no forget can ever remove.
 * Only a Gateway the projection does not name, which is a linked friend Domain, keeps its last rows.
 */
internal fun keepPriorRow(row: Team, homeGatewayId: String, planeDomain: String?, coveredGateways: Set<String>): Boolean {
	val gateway = row.gatewayId.ifEmpty { homeGatewayId }
	val foreignDomain = row.domainId != null && planeDomain != null && row.domainId != planeDomain
	return foreignDomain || (gateway != homeGatewayId && gateway !in coveredGateways)
}

internal fun teamInfoToTeam(it: TeamInfo, homeGatewayId: String): Team {
	val gatewayId = it.gatewayId.ifEmpty { homeGatewayId }
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
		// Stamped POLLED here because this mapper serves BOTH channels and cannot tell them apart
		// from the row alone. The caller that knows which channel it is holding re-stamps: the plane
		// default of the three - it claims nothing, where LIVE would claim freshness this row may
		// not have.
		presence = Presence.reported(
			status = it.status,
			authority = Authority.POLLED,
			mode = it.mode ?: "",
			queueDepth = it.queue_depth.toInt(),
			version = it.version,
			working = it.working,
			needsLogin = it.needsLogin,
			limitBlocked = it.limitBlocked,
			limitDetail = it.limitDetail,
		),
		kind = it.kind,
		domainId = it.domainId,
		displayName = it.displayName,
		isAdminDomain = it.isAdminDomain ?: false,
		sessionLabel = it.sessionLabel,
		presenceFresh = it.presenceFresh,
	)
}
