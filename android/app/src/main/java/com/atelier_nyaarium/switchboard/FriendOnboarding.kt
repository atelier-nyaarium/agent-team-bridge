package com.atelier_nyaarium.switchboard

data class HostedTenant(
	val domainId: String,
	val displayName: String,
	val nonce: String,
	val state: HostedTenantState,
)

enum class HostedTenantState {
	AWAITING_SETUP,

	OFFLINE,

	ONLINE,
}

sealed interface FirstRootDecision {
	data class Root(val domainId: String, val nonce: String) : FirstRootDecision

	data object NotPending : FirstRootDecision
}

data class FirstRootReject(val message: String, val transient: Boolean)

// Pending tenant selects first-root. Rooted devices skip it.
enum class NoGatewayState {
	NONE,

	AWAITING_HOST,

	NEEDS_GATEWAY,
}

object FriendOnboarding {
	fun renameAwaitsDiscovery(firstRooted: Boolean, domainId: String?): Boolean =
		firstRooted && domainId == null

	fun decide(prov: ConsoleCredentials, alreadyRooted: Boolean): FirstRootDecision {
		val pending = prov.pendingTenant
		if (pending == null || alreadyRooted) return FirstRootDecision.NotPending
		return FirstRootDecision.Root(pending.domainId, pending.nonce)
	}

	fun classifyFirstRootError(message: String?): FirstRootReject {
		// Clock skew and CAS contention retry. Invite failures are terminal.
		val m = message ?: "Setup could not be completed."
		return when {
			m.contains("invalid or expired invite", ignoreCase = true) ||
				m.contains("invite expired", ignoreCase = true) ||
				m.contains("already rooted", ignoreCase = true) ||
				m.contains("already claimed", ignoreCase = true) ->
				FirstRootReject("This setup code is expired or already used. Ask for a new one.", transient = false)
			m.contains("not available", ignoreCase = true) || m.startsWith("HTTP 501") ->
				FirstRootReject("This Domain isn't ready yet. Ask whoever invited you to finish their setup.", transient = false)
			m.contains("admin op is stale", ignoreCase = true) ->
				FirstRootReject("Your device clock is off - sync the time and setup will retry.", transient = true)
			m.contains("persist failed", ignoreCase = true) ->
				FirstRootReject("The server is busy - retrying.", transient = true)
			else -> FirstRootReject("Setup could not be completed: ${m.take(140)}", transient = true)
		}
	}

	fun humanizeFirstRootError(message: String?): String = classifyFirstRootError(message).message

	fun noGatewayState(noGateway: Boolean, firstRooted: Boolean): NoGatewayState =
		// First-rooted friends await a host. Admins need a Gateway.
		when {
			!noGateway -> NoGatewayState.NONE
			firstRooted -> NoGatewayState.AWAITING_HOST
			else -> NoGatewayState.NEEDS_GATEWAY
		}

	fun hostedState(domainId: String, teams: List<Team>): HostedTenantState {
		// A rooted tenant is online only when one of its sessions is live.
		val sessions = teams.filter { it.domainId == domainId }
		return when {
			sessions.isEmpty() -> HostedTenantState.AWAITING_SETUP
			sessions.any { it.isLive } -> HostedTenantState.ONLINE
			else -> HostedTenantState.OFFLINE
		}
	}
}
