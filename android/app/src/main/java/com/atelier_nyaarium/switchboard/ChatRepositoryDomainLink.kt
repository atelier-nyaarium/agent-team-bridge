package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

////////////////////////////////
//  This device's link to its Domain
//
//  Adopting the provisioning blob, the connection it buys, what this device tells its Gateways it
//  can render, who the connection says this owner is, this install's own name, and the wipe that
//  undoes all of it. Extensions rather than members: the fields these write (client, sttsClient,
//  localGatewayId, pluginReportPending) stay declared on the class, since an extension has no
//  backing field.

/**
 * Re-report after the owner toggles a plugin, so the change reaches the gateway now instead of
 * waiting for the next reconnect. A session already running keeps the tools it started with,
 * since an agent's tool list is fixed at startup.
 */
suspend fun ChatRepository.reportEnabledPlugins() = withContext(Dispatchers.IO) {
	pluginReportPending = true
	if (!_state.value.connected) return@withContext
	runCatchingCancellable { client().register(enabledPlugins?.invoke()) }
		.onSuccess { pluginReportPending = false }
		.onFailure { DebugLog.log("Plugins", "re-register after toggle failed, retrying: ${it.message?.take(120)}") }
	reportPluginsToOtherGateways()
	Unit
}

/** The same plugin list to every OTHER Gateway this owner has. A capability store is per
 * Gateway and only the route one hears a register, so a session homed elsewhere would otherwise
 * never get the tools at all. Best-effort per Gateway; an offline one keeps its last report. */
private suspend fun ChatRepository.reportPluginsToOtherGateways() {
	val plugins = enabledPlugins?.invoke() ?: return
	val route = localGatewayId
	// From the KEYRING, not the session roster: a Gateway with no sessions listed still needs
	// the report, and the first session created there would otherwise start with no tools.
	val others = sessions.otherKeyringGateways(route)
	for (gw in others) {
		runCatchingCancellable { client().reportPluginsTo(gw, plugins) }
			.onFailure { DebugLog.log("Plugins", "report to $gw failed (keeps its last): ${it.message?.take(80)}") }
	}
}

suspend fun ChatRepository.provision(blob: String) = withContext(Dispatchers.IO) {
	// Strict wire parse: reject before persisting. Surfaced as state.error
	// rather than thrown - callers launch this from coroutines with no
	// catch, and the strict kotlinx parse rejects malformed blobs (single
	// quotes, stringy numbers) instead of silently coercing them.
	val prov = try {
		Provisioning.parse(blob)
	} catch (e: Exception) {
		_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
		return@withContext
	}
	store.save(blob)
	// The blob is transport-only: the Console owns its locally-generated identity and resolves
	// every Gateway's keys from the synced keyring, so nothing cryptographic is imported. A
	// re-import is a fresh enrollment against a possibly re-rooted Domain, so clear the
	// console-admitted gate to re-submit this Console's admission on the next connect.
	store.consoleAdmitted = false
	// A re-import may carry a fresh invite (a friend re-onboarding, or a regenerated QR), so clear
	// the first-root latch: the next connect re-evaluates the blob's pendingTenant and re-roots if
	// present. An ordinary already-rooted blob (no pendingTenant) skips the step.
	store.firstRooted = false
	// A fresh invite is a fresh trust ceremony: re-offer the in-person compare on the next connect.
	store.enrollCeremonyDone = false
	client = null
	sttsClient = null
	// firstRooted=false in the state mirrors the latch reset so a re-imported fresh invite does not
	// show the "already set up" host pointer before the next connect re-evaluates the pendingTenant.
	_state.update { it.copy(provisioned = true, error = null, deviceName = prov.device, firstRooted = false) }
}

suspend fun ChatRepository.connect() = withContext(Dispatchers.IO) {
	// DEBUG: wire the ingest sender from the blob up front, BEFORE any enroll step can fail, then
	// flush on every exit path (the finally below). Otherwise a pre-register failure (admission
	// submit, register) strands its trace on-device until a poll cycle that never starts. The
	// attach + flush + every DebugLog.log here compile out of release builds (BuildConfig.DEBUG).
	runCatching { store.load()?.let { DebugLog.attachIngest(Provisioning.parse(it)) } }
	DebugLog.log("Connect", "start gateway=${localGatewayId.ifEmpty { "?" }} admitted=${store.consoleAdmitted}")
	try {
		// Preflight the cluster path (API server + SA token + TLS) before blaming the
		// bridge or enrollment, so a stale blob says "re-provision" and a missing
		// identity says "not enrolled" - two distinguishable causes.
		runCatchingCancellable { client().apiReachable() }.onFailure { e ->
			val (cause, kind) = classifyConnError(e)
			_state.update {
				if (kind == ConnKind.TERMINAL) {
					it.copy(status = "error", error = "Cluster: $cause", connected = false, enrollingSince = 0L)
				} else {
					it.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
				}
			}
			return@withContext
		}
		DebugLog.log("Connect", "apiReachable ok")
		// First-root step (friend invite): a blob carrying a pendingTenant means this app must
		// root that pending Domain at its silently-generated owner key BEFORE submitting its own
		// admission (evie only trusts the owner-signed admission once the Domain is rooted at that
		// owner key). A reject (expired / already-claimed invite) is terminal: the root was
		// decided, not dropped, so stop with the friendly guidance.
		if (!ownerFacts.firstRootIfPending()) return@withContext
		// Reflect the first-root latch into the UI state now, so if the steps below fail with the
		// no-gateway cause (a freshly-rooted friend has no host yet) the empty board shows the
		// "set up, now bring up a host" guidance rather than the admin Add-a-Gateway CTA.
		if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
		// Submit this Console's own admission before the sealed register, so the Gateway
		// has an owner-signed reason to trust its sealed ops. Bearer-gated, so it lands
		// even though the Console is not admitted yet. A THROW here (e.g. the Keystore-backed
		// store is unavailable, so the member identity cannot be persisted) is the REAL cause;
		// surface it instead of falling through to register()'s generic "not enrolled".
		runCatchingCancellable { ownerFacts.submitConsoleAdmission() }.onFailure { e ->
			val (cause, kind) = classifyConnError(e)
			_state.update {
				it.copy(
					status = if (kind == ConnKind.TERMINAL) "error" else "connecting",
					error = cause,
					connected = false,
					enrollingSince = 0L,
				)
			}
			return@withContext
		}
		// MailboxSync owns the durable cursor, so register's cursor/epoch are not adopted. We
		// still register to learn gatewayId, claim the mailbox, and get the epoch the box is on;
		// the poll loop's advance() reconciles any epoch change.
		val reg = client().register(enabledPlugins?.invoke())
		pluginReportPending = false
		DebugLog.log("Connect", "register ok gateway=${reg.gatewayId}")
		// Every OTHER Gateway needs the same list, or its sessions never learn this console's
		// capabilities. Fired after the roster exists, so it runs off the poll loop's first pass.
		repoScope.launch { reportPluginsToOtherGateways() }
		val id = reg.gatewayId
		if (id.isNotEmpty() && id != localGatewayId) {
			localGatewayId = id
			store.saveGatewayId(id)
		}
		// Pin every subsequent relay to this route Gateway so the Gateway routes there
		// even once other Gateways join the mesh.
		client().routeGateway = localGatewayId.ifEmpty { null }
		// A teams refresh failure is not a connect failure: register succeeded, so we
		// are connected. Log and proceed with the prior team list rather than masking
		// the error as an empty board (which would blank live sessions).
		val teams = runCatchingCancellable { client().teams(localGatewayId) }.getOrElse {
			DebugLog.log("Connect", "teams refresh failed: ${it.message?.take(120)}")
			_state.value.teams
		}
		// Seed the merge path's raw cache so a tombstone expiring before the first poll lands
		// still has something to self-heal from (see applyPresence/reapplyCachedTeams).
		presence.lastRawTeams = teams
		_state.update {
			it.copy(
				teams = teams.withoutTombstoned(),
				status = "connected",
				error = null,
				connected = true,
				pollFailStreak = 0,
				localGatewayId = localGatewayId,
				enrollingSince = 0L,
			)
		}
		presence.refreshDisplayNameFromTeams()
		DebugLog.log("Connect", "connected gateway=${localGatewayId.ifEmpty { "?" }}")
	} catch (e: Exception) {
		// MUST be the first statement: this catch spans the whole connect() attempt (register(),
		// teams(), submitConsoleAdmission(), firstRootIfPending() all suspend into the network), and
		// would otherwise defeat the cancellation rethrow guards on the runCatchingCancellable blocks
		// nested inside this same try - their rethrow lands right back here and gets swallowed too.
		e.rethrowIfCancellation()
		val (cause, kind) = classifyConnError(e)
		// "is not admitted" means the Gateway holds no admission for this Console. If we believed
		// we were admitted, the flag is stale (the submit never landed in evie) - clear it so the
		// next connect re-submits the admission instead of waiting forever on a calm sync-lag.
		if (kind == ConnKind.ENROLLING) store.consoleAdmitted = false
		_state.update { s ->
			when (kind) {
				// Post-enroll sync lag: calm "Finishing up enrollment..." (the poll loop
				// keeps retrying + clears it on the first success), escalating past the grace.
				ConnKind.ENROLLING -> {
					val (override, since) = enrollFold(s.enrollingSince)
					s.copy(
						status = if (override != null) "error" else "connecting",
						error = override ?: cause,
						connected = false,
						enrollingSince = since,
					)
				}
				ConnKind.TERMINAL -> s.copy(status = "error", error = cause, connected = false, enrollingSince = 0L)
				ConnKind.TRANSIENT -> s.copy(status = "connecting", error = cause, connected = false, enrollingSince = 0L)
			}
		}
	} finally {
		// DEBUG: stream whatever this attempt logged, even on the failure paths that return before
		// the poll loop's own flush would run. No-op in release (flushToIngest is BuildConfig.DEBUG).
		DebugLog.flushToIngest()
	}
}

/** This owner's display name, falling back to the local Domain id
 * before discovery has stamped a name. Shown as "YOU" on the Users surface. */
fun ChatRepository.displayName(): String = state.value.displayName.ifEmpty { confirmedDomainId().orEmpty() }

/** This owner's own Domain id, learned from a LOCAL session in the current board (the local
 * listing stamps domainId = the connected Gateway's Domain). Null until a local session confirms
 * it: the signing + cross-Domain routing sites refuse to act on a guessed id, so a frame never
 * names a Domain this device has not actually joined. */
fun ChatRepository.confirmedDomainId(): String? {
	val gw = localGatewayId
	return _state.value.teams.firstOrNull { (it.gatewayId.ifEmpty { gw }) == gw && !it.domainId.isNullOrEmpty() }?.domainId
}

/** The confirmed local Domain id, or throw - for the signing/routing ops that run inside a
 * runCatching so a not-yet-confirmed Domain surfaces as a clean failure instead of a guessed id. */
internal fun ChatRepository.confirmedDomainIdOrThrow(): String =
	confirmedDomainId() ?: error("Domain not yet confirmed by a local session")

/** True only when a LOCAL session confirms this device owns the ADMIN Domain (the one that runs
 * evie and provisions others), so it can host guest networks. evie stamps isAdminDomain on the
 * register reply and the gateway carries it onto the local TeamInfo. A guest (its own non-admin
 * Domain) returns false, and so does a device whose Domain is not yet confirmed - so the
 * Guest-networks admin section is hidden rather than shown as a dead button evie would reject
 * (provision_tenant is gated on the admin key, so "not admin-signed" for anyone else). */
fun ChatRepository.isAdmin(): Boolean {
	val gw = localGatewayId
	return _state.value.teams.any { (it.gatewayId.ifEmpty { gw }) == gw && it.isAdminDomain }
}

/** Whether to show "Revoke and Delete Domain": a CONFIRMED app-only user only. Never an admin (they
 * purge via setup.sh), and never while the Domain is unconfirmed. Both flags read the SAME local
 * session, so an unconfirmed id (offline, no teams) hides the action rather than letting an admin
 * whose gateway is down read the unknown state as "not admin" and delete their whole Domain. */
fun ChatRepository.canDeleteOwnDomain(): Boolean = !isAdmin() && confirmedDomainId() != null

////////////////////////////////
//  Display name (this owner's display name)

/** This owner's current display name, for the profile field + the MY NETWORK card. The
 * cache (refreshed from discovery) is authoritative for display; empty until the owner sets one. */
fun ChatRepository.localDisplayName(): String = _state.value.displayName

suspend fun ChatRepository.setDeviceName(name: String) = withContext(Dispatchers.IO) {
	val blob = store.load() ?: return@withContext
	val j = JSONObject(blob).put("device", name)
	store.save(j.toString())
	client = null
	_state.update { it.copy(deviceName = name) }
	connect()
}

// internal (not private): the _state initializer (ChatRepository.kt) seeds the device name with it.
internal fun ChatRepository.currentDeviceName(): String =
	store.load()?.let { runCatching { Provisioning.parse(it).device }.getOrNull() } ?: ""

suspend fun ChatRepository.clearAll() = withContext(Dispatchers.IO) {
	// cancelAndJoin (not cancel): the poll loop's transport is cancellable, so a pass suspended
	// in it usually unwinds promptly - but a cancel landing in the loop's non-suspend tail still
	// completes that pass normally before the job finishes, and that tail is NOT always brief:
	// its last statement is DebugLog.flushToIngest(), a plain blocking HttpURLConnection POST
	// with only per-phase connect/read timeouts (no overall call bound), so a trickling ingest
	// endpoint can hold it open well past either one. cancel() alone would let this function race
	// ahead and reset state while that tail is still about to persist mail and re-touch _state.
	// Joining serializes against it, so the worst case is this function waiting out that tail
	// (bounded in practice, not in principle), not a silent resurrection of wiped state.
	drain.stopAndJoin()
	// Preserve the settings-owned voice creds + taste: Clear & re-provision wipes
	// provisioning/identity/history, never voice (clear() is the full factory wipe).
	store.clearProvisioning()
	client = null
	sttsClient = null
	stts.purgeAll()
	// Paired with the TTS purge above, same as the one-shot schema-migration wipe does (see
	// init{}): the prefs wipe never touches filesDir, so downloaded attachments would
	// otherwise survive a Revoke-and-Delete/Clear-and-re-provision indefinitely.
	Attachments.purgeAll(filesDir)
	localGatewayId = ""
	mailboxSync.clearInMemory()
	_state.update { ChatState(provisioned = false) }
	// The fresh ChatState() above already resets scheduledSends to empty (and its own key is
	// wiped from disk, being in PROVISIONING_KEYS) - only the OS-level alarm resource needs an
	// explicit cancel. A stray late fire/retry after this would be harmless regardless (both
	// re-check live state fresh and no-op on a miss), this just avoids a pointless wakeup.
	scheduled.scheduledSendScheduler?.cancelNext()
}
