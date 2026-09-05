package com.atelier_nyaarium.switchboard

/**
 * Pure (Android-free) helpers for friend cross-Domain onboarding: the first-root decision, the
 * reject-message humanization, and the "Networks you host" row model. Kept here so a JVM unit test
 * pins the branch logic without a device; the crypto is pinned by ProvisionOpsTest's vectors.
 */

////////////////////////////////
//  Interfaces & Types

/** A hosted guest tenant row for the "Networks you host" admin list. Built locally from the
 * admin's own provisioned tenants; the Router holds the canonical pending/rooted state, surfaced
  */
data class HostedTenant(
	/** The opaque Domain id, never the row's title. */
	val domainId: String,
	/** The display name the admin chose (the row title). */
	val displayName: String,
	/** The one-time invite nonce, so the row can re-render its QR / blob. */
	val nonce: String,
	val state: HostedTenantState,
)

/** The lifecycle of a hosted tenant as the host sees it. */
enum class HostedTenantState {
	/** Provisioned but the friend has not first-rooted + brought a gateway online yet. */
	AWAITING_SETUP,

	OFFLINE,

	/** At least one of the tenant's sessions is online. */
	ONLINE,
}

/** The result of evaluating a freshly-imported blob for the first-root path. */
sealed interface FirstRootDecision {
	/** The blob carries a pending tenant and the app must first-root it (carrying the nonce). */
	data class Root(val domainId: String, val nonce: String) : FirstRootDecision

	/** No pending tenant (an ordinary already-rooted admin blob): skip first-root, just provision. */
	data object NotPending : FirstRootDecision
}

/** A classified first-root reject: the human message plus whether the Router's rejection is
 * transient (the poll loop auto-retries) or terminal. Clock skew and CAS persist contention are transient;
 * an expired/used invite or an unconfigured host is terminal. */
data class FirstRootReject(val message: String, val transient: Boolean)

/** Which empty-board guidance to show when the Console has no Gateway to seal to yet. A friend who
 * just first-rooted still has to bring a host online; an admin who never first-rooted just needs to
 * admit a Gateway. Same "no gateway" cause, different copy and CTA. */
enum class NoGatewayState {
	/** Not a no-gateway situation (a Gateway is admitted, or the cause is some other error). */
	NONE,

	/** A friend who has first-rooted but has no host yet: point at the "Setting up a host" manual. */
	AWAITING_HOST,

	/** An admin with no Gateway admitted yet: the Add-a-Gateway onboarding CTA. */
	NEEDS_GATEWAY,
}

////////////////////////////////
//  Functions & Helpers

object FriendOnboarding {
	/** A rooted device with no Domain id yet cannot sign a rename. */
	fun renameAwaitsDiscovery(firstRooted: Boolean, domainId: String?): Boolean =
		firstRooted && domainId == null

	/** Decide whether a provisioning blob asks the app to first-root a pending Domain. The blob's
	 * `pendingTenant` is the only discriminator (a register reply never reports pending), so present
	 * -> Root, absent -> NotPending. `alreadyRooted` short-circuits to NotPending so a reconnect
	 * after a successful root does not re-POST first_root. */
	fun decide(prov: ConsoleCredentials, alreadyRooted: Boolean): FirstRootDecision {
		val pending = prov.pendingTenant
		if (pending == null || alreadyRooted) return FirstRootDecision.NotPending
		return FirstRootDecision.Root(pending.domainId, pending.nonce)
	}

	/** Classify the Router's first-root reject into a human line + transient/terminal verdict. An
	 * opaque invalid/expired/already-claimed invite is terminal and collapses to "ask the host for a
	 * fresh code". Clock skew ("admin op is stale") and a persist-CAS contention at the Router
	 * ("persist failed") are transient, so the poll loop re-attempts and the friend is told to wait
	 * rather than shown a hard failure. An unknown failure passes through trimmed as transient. */
	fun classifyFirstRootError(message: String?): FirstRootReject {
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

	/** The human-readable first-root reject line (the [classifyFirstRootError] message). Kept as the
	 * one-arg form the message-only call sites use. */
	fun humanizeFirstRootError(message: String?): String = classifyFirstRootError(message).message

	/** Split the "no Gateway admitted" empty-board cause into the admin's Add-a-Gateway onboarding
	 * vs the friend's bring-up-a-host state. `noGateway` is the connect-error classification;
	 * `firstRooted` is true only after this device rooted a pending friend Domain. A device that
	 * first-rooted and then lands with no Gateway is a friend awaiting a host, not an admin who
	 * forgot to admit one. */
	fun noGatewayState(noGateway: Boolean, firstRooted: Boolean): NoGatewayState =
		when {
			!noGateway -> NoGatewayState.NONE
			firstRooted -> NoGatewayState.AWAITING_HOST
			else -> NoGatewayState.NEEDS_GATEWAY
		}

	 /**
	 * session in `teams` is rooted (online iff any is online); one with no presence session is
	 * still awaiting the friend's first-root + gateway bringup. */
	fun hostedState(domainId: String, teams: List<Team>): HostedTenantState {
		val sessions = teams.filter { it.domainId == domainId }
		return when {
			sessions.isEmpty() -> HostedTenantState.AWAITING_SETUP
			sessions.any { it.isLive } -> HostedTenantState.ONLINE
			else -> HostedTenantState.OFFLINE
		}
	}
}
