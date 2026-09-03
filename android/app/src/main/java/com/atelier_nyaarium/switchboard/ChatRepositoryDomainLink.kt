package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.json.JSONObject

// This device's Domain link.

/** Report plugin changes. */
suspend fun ChatRepository.reportEnabledPlugins() = withContext(Dispatchers.IO) {
	pluginReportPending = true
	if (!_state.value.connected) return@withContext
	runCatchingCancellable { reportCapabilitiesToRouter() }
		.onSuccess { pluginReportPending = false }
		.onFailure { DebugLog.log("Plugins", "capability report failed, retrying: ${it.message?.take(120)}") }
	Unit
}

/** Report once to the Router. */
private suspend fun ChatRepository.reportCapabilitiesToRouter() {
	val plugins = enabledPlugins?.invoke() ?: return
	val op = buildJsonObject {
		put("kind", JsonPrimitive("capabilities_report"))
		put("capabilities", wireJson.encodeToJsonElement(ListSerializer(EnabledPlugin.serializer()), plugins))
	}
	val signed = ownerOps.sign(op) ?: error("cannot sign capabilities report")
	runCatchingCancellable { client().postOwnerOp(signed) }
		.onFailure { DebugLog.log("Plugins", "capability report failed, retrying next toggle: ${it.message?.take(80)}") }
}

suspend fun ChatRepository.provision(blob: String) = withContext(Dispatchers.IO) {
	// Reject malformed blobs before persisting.
	val prov = try {
		Provisioning.parse(blob)
	} catch (e: Exception) {
		_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
		return@withContext
	}
	store.save(blob)
	homeGatewayId = ""
	store.saveGatewayId("")
	// Re-import requires fresh admission.
	store.consoleAdmitted = false
	// Re-evaluate pending invites.
	store.firstRooted = false
	// Re-offer the trust ceremony.
	store.enrollCeremonyDone = false
	client = null
	sttsClient = null
	// Mirror the reset in UI state.
	_state.update {
		it.copy(provisioned = true, error = null, deviceName = prov.device, firstRooted = false, homeGatewayId = "")
	}
}

/** Normalize a SHA-256 leaf fingerprint. */
internal fun normalizeCertFp(raw: String): String? {
	val stripped = raw.trim().filterNot { it == ':' || it == ' ' || it == '-' }.lowercase()
	if (stripped.length != 64 || !stripped.all { it.isDigit() || it in 'a'..'f' }) return null
	return stripped
}

/** Display-only Router endpoint fields. */
// Credentials never reach the screen.
data class RouterEndpoint(val host: String, val port: Int, val certFp: String, val direct: Boolean)

internal fun parseRouterUrl(url: String, fallbackPort: Int): Pair<String, Int>? {
	val body = url.trim().removeSuffix("/").substringAfter("://", url.trim().removeSuffix("/"))
	if (body.isEmpty()) return null
	val colon = body.lastIndexOf(':')
	if (colon <= 0) return body to fallbackPort
	val port = body.substring(colon + 1).toIntOrNull() ?: return body to fallbackPort
	return body.substring(0, colon) to port
}

/** Current direct Router endpoint. */
fun ChatRepository.currentRouterEndpoint(fallbackPort: Int): RouterEndpoint? {
	val blob = store.load() ?: return null
	val json = runCatching { JSONObject(blob) }.getOrNull() ?: return null
	val direct = json.optString("transport") == "direct"
	val url = json.optString("routerUrl")
	if (url.isEmpty()) return null
	val (host, port) = parseRouterUrl(url, fallbackPort) ?: return null
	return RouterEndpoint(host, port, json.optString("routerCertFp"), direct)
}

/** Change transport fields only. */
suspend fun ChatRepository.setEndpoint(host: String, port: Int, certFp: String) = withContext(Dispatchers.IO) {
	// Allow endpoint setup before provisioning.
	val blob = store.load() ?: "{}"
	val trimmedHost = host.trim().removeSuffix("/")
	if (trimmedHost.isEmpty()) {
		_state.update { it.copy(error = "Enter a domain or IP.") }
		return@withContext
	}
	val fp = normalizeCertFp(certFp) ?: run {
		_state.update { it.copy(error = "Fingerprint must be 64 hex characters (SHA-256).") }
		return@withContext
	}
	val url = if (trimmedHost.startsWith("http")) "$trimmedHost:$port" else "https://$trimmedHost:$port"
	val edited = JSONObject(blob).apply {
		put("transport", "direct")
		put("routerUrl", url)
		put("routerCertFp", fp)
	}.toString()
	try {
		Provisioning.parse(edited)
	} catch (e: Exception) {
		_state.update { it.copy(error = "Invalid endpoint: ${e.message?.take(160) ?: "unparseable"}") }
		return@withContext
	}
	store.save(edited)
	client = null
	sttsClient = null
	_state.update { it.copy(error = null) }
}

suspend fun ChatRepository.connect() = withContext(Dispatchers.IO) {
	// Attach debug ingest before enrollment.
	runCatching { store.load()?.let { DebugLog.attachIngest(Provisioning.parse(it)) { client().transport.proxyBase } } }
	DebugLog.log("Connect", "start gateway=${homeGatewayId.ifEmpty { "?" }} admitted=${store.consoleAdmitted}")
	try {
		// Distinguish cluster failures early.
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
		// Root pending invites before admission.
		if (!ownerFacts.firstRootIfPending()) return@withContext
		// Reflect first-root state in the UI.
		if (store.firstRooted && !_state.value.firstRooted) _state.update { it.copy(firstRooted = true) }
		// Submit admission before sealed register.
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
		val admitted = sessions.keyringGateways()
		val id = _state.value.homeGatewayId.takeIf { it in admitted } ?: admitted.firstOrNull().orEmpty()
		if (id != homeGatewayId) {
			homeGatewayId = id
			store.saveGatewayId(id)
		}
		pluginReportPending = false
		repoScope.launch { reportCapabilitiesToRouter() }
		val teams = _state.value.teams
		_state.update {
			it.copy(
				teams = teams.withoutTombstoned(),
				status = "connected",
				error = null,
				connected = true,
				pollFailStreak = 0,
				homeGatewayId = homeGatewayId,
				enrollingSince = 0L,
				// Publish sessions and roster together.
				admittedGateways = sessions.keyringGateways(),
			)
		}
		val domain = confirmedDomainId()
		domain?.let { store.saveDomainId(it) }
		ownerFacts.ensureContentEpochs(domain)
		presence.refreshDisplayNameFromTeams()
		DebugLog.log("Connect", "connected gateway=${homeGatewayId.ifEmpty { "?" }} domain=${domain ?: "none"}")
	} catch (e: Exception) {
		// Rethrow cancellation before connection handling.
		e.rethrowIfCancellation()
		val (cause, kind) = classifyConnError(e)
		// Retry stale admission state.
		if (kind == ConnKind.ENROLLING) store.consoleAdmitted = false
		_state.update { s ->
			when (kind) {
				// Allow post-enrollment sync lag.
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
		// Flush debug ingest on exit.
		DebugLog.flushToIngest()
	}
}

/** This owner's display name. */
fun ChatRepository.displayName(): String = state.value.displayName.ifEmpty { confirmedDomainId().orEmpty() }

/** Confirmed local Domain id. */
fun ChatRepository.confirmedDomainId(): String? {
	val gw = homeGatewayId
	val fromRoster = _state.value.teams.firstOrNull { (it.gatewayId.ifEmpty { gw }) == gw && !it.domainId.isNullOrEmpty() }?.domainId
	// The roster arrives over signed reads, so the Router's reach answer seeds the id.
	return fromRoster ?: store.loadDomainId().takeIf { it.isNotEmpty() }
}

/** Confirmed local Domain id or error. */
internal fun ChatRepository.confirmedDomainIdOrThrow(): String =
	confirmedDomainId() ?: error("Domain not yet confirmed by a local session")

/** True when the local session owns the admin Domain. */
fun ChatRepository.isAdmin(): Boolean {
	val gw = homeGatewayId
	return _state.value.teams.any { (it.gatewayId.ifEmpty { gw }) == gw && it.isAdminDomain }
}

/** True for confirmed app-only users. */
fun ChatRepository.canDeleteOwnDomain(): Boolean = !isAdmin() && confirmedDomainId() != null

// Display name.

/** Cached display name. */
fun ChatRepository.localDisplayName(): String = _state.value.displayName

suspend fun ChatRepository.setDeviceName(name: String) = withContext(Dispatchers.IO) {
	val blob = store.load() ?: return@withContext
	val updated = runCatching { JSONObject(blob).put("device", name).toString() }
		.getOrElse { e ->
			_state.update { it.copy(transientMessages = it.transientMessages + (e.message ?: "Invalid provisioning blob")) }
			return@withContext
		}
	store.save(updated)
	client = null
	_state.update { it.copy(deviceName = name) }
	connect()
}

internal fun ChatRepository.currentDeviceName(): String =
	store.load()?.let { runCatching { Provisioning.parse(it).device }.getOrNull() } ?: ""

suspend fun ChatRepository.clearAll() = withContext(Dispatchers.IO) {
	// Join the poll loop before wiping state.
	drain.stopAndJoin()
	// Preserve voice settings.
	store.clearProvisioning()
	// Wipe durable state first.
	for (cache in clearedOnReprovision) cache.clearInMemory()
	stts.purgeAll()
	// Purge file-backed attachments too.
	Attachments.purgeAll(filesDir)
	_state.update { ChatState(provisioned = false) }
	// Cancel the OS-level alarm.
	scheduled.scheduledSendScheduler?.cancelNext()
}
