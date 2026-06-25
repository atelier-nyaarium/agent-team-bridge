package com.atelier_nyaarium.switchboard

/**
 * Pure (Android-free) helpers for the friend cross-Domain onboarding: the first-root decision
 * (does this blob ask the app to root a pending Domain), the reject-message humanization, and the
 * "Networks you host" row model. Kept here so a JVM unit test pins the branch logic without a
 * device - the crypto itself is pinned by ProvisionOpsTest's cross-runtime vectors.
 */

////////////////////////////////
//  Interfaces & Types

/** A hosted guest tenant row for the "Networks you host" admin list. Built locally from the
 * operator's own provisioned tenants (the app remembers what it staged); evie holds the canonical
 * pending/rooted state, surfaced lazily through discovery once the friend's gateway comes online. */
data class HostedTenant(
	/** The opaque Domain id (plumbing; never the row's title). */
	val domainId: String,
	/** The network display label the operator chose (the row title). */
	val displayName: String,
	/** The one-time invite nonce, so the row can re-render its QR / blob. */
	val nonce: String,
	/** awaiting-setup -> offline -> online, derived from discovery presence. */
	val state: HostedTenantState,
)

/** The lifecycle of a hosted tenant as the host sees it. */
enum class HostedTenantState {
	/** Provisioned but the friend has not first-rooted + brought a gateway online yet. */
	AWAITING_SETUP,

	/** Rooted (a gateway has appeared in discovery for it) but currently offline. */
	OFFLINE,

	/** At least one of the tenant's sessions is online. */
	ONLINE,
}

/** The result of evaluating a freshly-imported blob for the first-root path. */
sealed interface FirstRootDecision {
	/** The blob carries a pending tenant and the app must first-root it (carrying the nonce). */
	data class Root(val domainId: String, val nonce: String) : FirstRootDecision

	/** No pending tenant (an ordinary already-rooted operator blob): skip first-root, just provision. */
	data object NotPending : FirstRootDecision
}

/** A classified first-root reject: the human message plus whether evie's rejection is transient
 * (the latch stays false, the poll loop auto-retries) or terminal (the root was decided and waiting
 * will not help). Clock skew ("operator op is stale") and a CAS persist contention ("persist
 * failed") are transient; an expired/used invite or an unconfigured host is terminal. */
data class FirstRootReject(val message: String, val transient: Boolean)

/** Which empty-board guidance to show when the Console has no Gateway to seal to yet. The friend's
 * invite blob omits gateway ids by design, so right after a successful first-root the friend is set
 * up but still has to bring a host online; an operator who never first-rooted just needs to admit a
 * Gateway. The two states share the "no gateway" cause but want different copy and a different CTA. */
enum class NoGatewayState {
	/** Not a no-gateway situation (a Gateway is admitted, or the cause is some other error). */
	NONE,

	/** A friend who has first-rooted but has no host yet: point at the "Setting up a host" manual. */
	AWAITING_HOST,

	/** An operator with no Gateway admitted yet: the Add-a-Gateway onboarding CTA. */
	NEEDS_GATEWAY,
}

////////////////////////////////
//  Functions & Helpers

object FriendOnboarding {
	/** Whether a display-name rename must wait for discovery. A device that has first-rooted its own
	 * Domain but whose local session has not yet reported a confirmed Domain id (null) cannot sign a
	 * rename over a real Domain, so gate Save until discovery lands one. A device that is not
	 * firstRooted is never gated. Pure so the gate is pinned without a live board. */
	fun renameAwaitsDiscovery(firstRooted: Boolean, confirmedDomainId: String?): Boolean =
		firstRooted && confirmedDomainId == null

	/** Decide whether a provisioning blob asks the app to first-root a pending Domain. The blob's
	 * `pendingTenant` is the ONLY discriminator (a register reply never reports pending), so a blob
	 * with it present -> Root, absent -> NotPending. `alreadyRooted` short-circuits to NotPending so
	 * a reconnect after a successful root does not re-POST first_root. */
	fun decide(prov: Provisioning, alreadyRooted: Boolean): FirstRootDecision {
		val pending = prov.pendingTenant
		if (pending == null || alreadyRooted) return FirstRootDecision.NotPending
		return FirstRootDecision.Root(pending.domainId, pending.nonce)
	}

	/** Classify evie's first-root reject into a human line + transient/terminal verdict.
	 *
	 * evie returns an OPAQUE "invalid or expired invite" for an absent/wrong-nonce/already-claimed
	 * slug and a distinct "invite expired" for a lapsed-but-valid nonce; both are terminal (the root
	 * was decided) and collapse to "ask the host for a fresh code". "operator op is stale" (a >2min
	 * device clock skew) and "persist failed" (an evie Secret-CAS contention) are TRANSIENT: the latch
	 * stays false and the poll loop re-attempts, so the friend is told to wait/sync rather than shown a
	 * hard failure. A transport/unknown failure passes through trimmed as transient (a retry may clear
	 * it). */
	fun classifyFirstRootError(message: String?): FirstRootReject {
		val m = message ?: "Setup could not be completed."
		return when {
			m.contains("invalid or expired invite", ignoreCase = true) ||
				m.contains("invite expired", ignoreCase = true) ||
				m.contains("already rooted", ignoreCase = true) ||
				m.contains("already claimed", ignoreCase = true) ->
				FirstRootReject("This setup code is expired or already used. Ask for a new one.", transient = false)
			m.contains("not available", ignoreCase = true) || m.startsWith("HTTP 501") ->
				FirstRootReject("This network isn't ready yet. Ask whoever invited you to finish their setup.", transient = false)
			m.contains("operator op is stale", ignoreCase = true) ->
				FirstRootReject("Your device clock is off - sync the time and setup will retry.", transient = true)
			m.contains("persist failed", ignoreCase = true) ->
				FirstRootReject("The server is busy - retrying.", transient = true)
			else -> FirstRootReject("Setup could not be completed: ${m.take(140)}", transient = true)
		}
	}

	/** The human-readable first-root reject line (the [classifyFirstRootError] message). Kept as the
	 * one-arg form the message-only call sites use. */
	fun humanizeFirstRootError(message: String?): String = classifyFirstRootError(message).message

	/** Split the "no Gateway admitted" empty-board cause into the operator's Add-a-Gateway onboarding
	 * vs the friend's just-set-up-now-bring-up-a-host state. `noGateway` is the connect-error
	 * classification (true once resolveGatewayId throws and classifyConnError emits the no-gateway
	 * cause); `firstRooted` is true only after this device rooted a pending friend Domain. A device
	 * that first-rooted and then lands with no Gateway is a friend awaiting a host, not an operator
	 * who forgot to admit one. Pure so the branch is pinned without a live board. */
	fun noGatewayState(noGateway: Boolean, firstRooted: Boolean): NoGatewayState =
		when {
			!noGateway -> NoGatewayState.NONE
			firstRooted -> NoGatewayState.AWAITING_HOST
			else -> NoGatewayState.NEEDS_GATEWAY
		}

	/** Derive each hosted tenant's display state from discovery. A tenant whose Domain has any
	 * session in `teams` is rooted (online iff any is online); one with no discovery session is
	 * still awaiting the friend's first-root + gateway bringup. Pure so the state machine is
	 * unit-tested without a live board. */
	fun hostedState(domainId: String, teams: List<Team>): HostedTenantState {
		val sessions = teams.filter { it.domainId == domainId }
		return when {
			sessions.isEmpty() -> HostedTenantState.AWAITING_SETUP
			sessions.any { it.status == "online" } -> HostedTenantState.ONLINE
			else -> HostedTenantState.OFFLINE
		}
	}
}
