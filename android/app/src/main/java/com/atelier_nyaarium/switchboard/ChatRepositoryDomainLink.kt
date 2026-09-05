package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
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
internal suspend fun ChatRepository.reportCapabilitiesToRouter() {
	val plugins = enabledPlugins?.invoke() ?: return
	val op = composeCapabilitiesReport(plugins)
	val signed = ownerOps.sign(op) ?: error("cannot sign capabilities report")
	runCatchingCancellable { client().postOwnerOp(signed) }
		.onFailure { DebugLog.log("Plugins", "capability report failed, retrying next toggle: ${it.message?.take(80)}") }
}

suspend fun ChatRepository.provision(blob: String) = withContext(Dispatchers.IO) {
	// Reject malformed blobs before persisting.
	val prov = try {
		ConsoleCredentials.parse(blob, store)
	} catch (e: Exception) {
		_state.update { it.copy(error = "Invalid provisioning blob: ${e.message?.take(160) ?: "unparseable"}") }
		return@withContext
	}
	identity.provision(blob)
	homeGatewayId = ""
	invalidateClient()
	sttsClient = null
	// Mirror the reset in UI state.
	_state.update {
		it.copy(provisioned = true, error = null, deviceName = prov.device, firstRooted = false, homeGatewayId = "", teams = emptyList())
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
		ConsoleCredentials.parse(edited, store)
	} catch (e: Exception) {
		_state.update { it.copy(error = "Invalid endpoint: ${e.message?.take(160) ?: "unparseable"}") }
		return@withContext
	}
	identity.saveBlob(edited)
	invalidateClient()
	sttsClient = null
	_state.update { it.copy(error = null) }
}

suspend fun ChatRepository.connect() = withContext(Dispatchers.IO) { connector.connect() }

/** This owner's display name. */
fun ChatRepository.displayName(): String = state.value.displayName.ifEmpty { readyOrNull()?.domainId.orEmpty() }

/** True when the local session owns the admin Domain. */
fun ChatRepository.isAdmin(): Boolean {
	val gw = homeGatewayId
	return _state.value.teams.any { (it.gatewayId.ifEmpty { gw }) == gw && it.isAdminDomain }
}

/** True for confirmed app-only users. */
fun ChatRepository.canDeleteOwnDomain(): Boolean = !isAdmin() && readyOrNull()?.domainId != null

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
	identity.saveBlob(updated)
	invalidateClient()
	_state.update { it.copy(deviceName = name) }
	connect()
}

internal fun ChatRepository.currentDeviceName(): String =
	store.load()?.let { runCatching { ConsoleCredentials.parse(it, store).device }.getOrNull() } ?: ""

suspend fun ChatRepository.clearAll() = withContext(Dispatchers.IO) {
	// Join the poll loop before wiping state.
	drain.stopAndJoin()
	// Preserve voice settings.
	identity.clear()
	// Wipe durable state first.
	for (cache in clearedOnReprovision) cache.clearInMemory()
	stts.purgeAll()
	// Purge file-backed attachments too.
	Attachments.purgeAll(filesDir)
	_state.update { ChatState(provisioned = false) }
	// Cancel the OS-level alarm.
	scheduled.scheduledSendScheduler?.cancelNext()
}
