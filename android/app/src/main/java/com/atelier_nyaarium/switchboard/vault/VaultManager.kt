package com.atelier_nyaarium.switchboard.vault

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.crypto.VAULT_GATEWAYS_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

interface VaultStore {
	fun loadVault(): String?

	fun saveVault(json: String)
}

/** The Router-held entry set, the requests awaiting an answer, and the grants last read. */
class VaultManager(private val store: VaultStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }

	private data class ViewMemo(val stored: List<VaultStoredEntry>, val epochs: List<Int>, val views: List<VaultEntryView>)

	@Volatile private var blob: VaultBlob = load()
	@Volatile private var memo: ViewMemo? = null

	// Guard every blob read-modify-write.
	private val stateLock = Any()

	/** Bumps on every change, for Compose. */
	val revision = mutableLongStateOf(0L)

	private val _pending = MutableStateFlow(blob.requests)

	/** Requests awaiting an answer, oldest first. */
	val pending: StateFlow<List<VaultPendingRequest>> = _pending

	/** Active grants per gateway, as last read through `vault_grants`. */
	val grants = mutableStateOf<Map<String, List<VaultGrant>>>(emptyMap())

	// Requests past their deadline do not come back.
	private fun load(now: Long = System.currentTimeMillis()): VaultBlob {
		val raw = store.loadVault() ?: return VaultBlob()
		val loaded = runCatching { json.decodeFromString<VaultBlob>(raw) }.getOrNull()
			?: return VaultBlob().also { DebugLog.log("Vault", "stored vault could not be decoded; starting empty") }
		return loaded.copy(requests = loaded.requests.filter { it.deadlineAt > now })
	}

	private fun persist(next: VaultBlob) {
		if (next == blob) return
		blob = next
		store.saveVault(json.encodeToString(VaultBlob.serializer(), next))
		_pending.value = next.requests
		revision.longValue++
	}

	private fun mutate(transform: (VaultBlob) -> VaultBlob) {
		synchronized(stateLock) { persist(transform(blob)) }
	}

	fun snapshot(): VaultBlob = synchronized(stateLock) { blob }

	val routerRevision: Long get() = snapshot().revision

	/** A full list replaces; a Router that fell behind gets asked for one next. */
	fun applyList(result: VaultListResult, at: Long = System.currentTimeMillis()): Boolean {
		synchronized(stateLock) {
			val current = blob
			if (result.since != 0L && result.revision < current.revision) {
				persist(current.copy(revision = 0L))
				return false
			}
			val base = if (result.since == 0L) emptyMap() else current.stored.associateBy { it.clear.id }
			val merged = base + result.entries.associateBy { it.clear.id }
			persist(
				current.copy(
					revision = result.revision,
					stored = merged.values.sortedBy { it.clear.id },
					lastRouterSyncAt = at,
				),
			)
			return true
		}
	}

	/** Lands a write's own entry; the revision advances only when nothing was skipped. */
	fun applyWrite(entry: VaultStoredEntry, revision: Long, at: Long = System.currentTimeMillis()) {
		mutate { current ->
			val stored = (current.stored.associateBy { it.clear.id } + (entry.clear.id to entry)).values.sortedBy { it.clear.id }
			val next = if (revision == current.revision + 1) revision else current.revision
			current.copy(revision = next, stored = stored, lastRouterSyncAt = at)
		}
	}

	fun live(): List<VaultStoredEntry> = snapshot().stored.filter { !it.clear.tombstone }

	fun stored(id: String): VaultStoredEntry? = snapshot().stored.firstOrNull { it.clear.id == id && !it.clear.tombstone }

	/** Opened views of every live entry, memoized per stored list and key epochs. */
	fun views(sealing: VaultSealing): List<VaultEntryView> {
		val current = snapshot()
		memo?.takeIf { it.stored === current.stored && it.epochs == sealing.epochs }?.let { return it.views }
		val views = current.stored.filter { !it.clear.tombstone }.map { view(it, sealing) }
		memo = ViewMemo(current.stored, sealing.epochs, views)
		return views
	}

	fun view(entry: VaultStoredEntry, sealing: VaultSealing): VaultEntryView {
		val id = entry.clear.id
		val open = { env: ContentEnvelope?, kind: String -> env?.let { sealing.open(it, kind, id) } }
		val gatewaysText = open(entry.sealed.gateways, VAULT_GATEWAYS_KIND)
		val gateways = gatewaysText?.let { parseGateways(it) }
		return VaultEntryView(
			id = id,
			revision = entry.clear.revision,
			createdBy = entry.clear.createdBy,
			createdAt = entry.clear.createdAt,
			updatedAt = entry.clear.updatedAt,
			publicTitle = open(entry.sealed.publicTitle, VAULT_PUBLIC_TITLE_KIND),
			publicDescription = open(entry.sealed.publicDescription, VAULT_PUBLIC_DESCRIPTION_KIND),
			privateTitle = open(entry.sealed.privateTitle, VAULT_PRIVATE_TITLE_KIND),
			privateDescription = open(entry.sealed.privateDescription, VAULT_PRIVATE_DESCRIPTION_KIND),
			gateways = gateways,
			gatewaysUnreadable = entry.sealed.gateways != null && gateways == null,
			hasValue = entry.sealed.value != null,
		)
	}

	fun openValue(entry: VaultStoredEntry, sealing: VaultSealing): String? =
		entry.sealed.value?.let { sealing.open(it, VAULT_VALUE_KIND, entry.clear.id) }

	/** A duplicate dispatch or an expired request is dropped. */
	fun addRequest(team: String, request: VaultRequest, now: Long = System.currentTimeMillis()): Boolean {
		synchronized(stateLock) {
			if (request.deadlineAt <= now) return false
			if (blob.requests.any { it.requestId == request.requestId }) return false
			persist(blob.copy(requests = blob.requests + VaultPendingRequest(team, request, now)))
			return true
		}
	}

	fun request(requestId: String): VaultPendingRequest? = snapshot().requests.firstOrNull { it.requestId == requestId }

	fun settleRequest(requestId: String) {
		mutate { it.copy(requests = it.requests.filterNot { pending -> pending.requestId == requestId }) }
	}

	/** Drops requests past their deadline; true when any went. */
	fun sweepRequests(now: Long = System.currentTimeMillis()): Boolean {
		synchronized(stateLock) {
			val kept = blob.requests.filter { it.deadlineAt > now }
			if (kept.size == blob.requests.size) return false
			persist(blob.copy(requests = kept))
			return true
		}
	}

	fun forgetTeam(team: String) {
		mutate { it.copy(requests = it.requests.filterNot { pending -> pending.team == team }) }
	}

	fun setGrants(gatewayId: String, list: List<VaultGrant>) {
		grants.value = grants.value + (gatewayId to list)
		revision.longValue++
	}

	/** Everything held, for a wipe or a re-provision. */
	fun wipe() {
		synchronized(stateLock) {
			blob = VaultBlob()
			memo = null
			grants.value = emptyMap()
			_pending.value = emptyList()
			revision.longValue++
		}
	}

	override suspend fun clearInMemory() = wipe()

	private fun parseGateways(text: String): List<String>? =
		runCatching { json.parseToJsonElement(text) as? JsonArray }.getOrNull()
			?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null }
}
