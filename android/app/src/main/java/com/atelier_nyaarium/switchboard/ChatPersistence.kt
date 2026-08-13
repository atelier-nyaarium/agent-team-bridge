package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.parseTarget
import org.json.JSONArray
import org.json.JSONObject

////////////////////////////////
//  Functions & Helpers

/** A persisted thread/label/draft key is a canonical 4-segment address (domain.gateway.spawn.session).
 * Anything else - a key with a device name substituted for a segment, or any non-canonical shorter
 * form - is dropped on load so it cannot resurface as an unsendable ghost chat; re-saving the cleaned
 * map drops it for good. The exact-3-dots check enforces arity 4 (parseTarget alone also accepts
 * arity 1/2/3), and at arity 4 parseTarget ignores both locality args, so this is a pure function. */
private fun isAddressKey(rawKey: String): Boolean =
	rawKey.count { it == '.' } == 3 && runCatching { parseTarget(rawKey, "", "") }.isSuccess

////////////////////////////////
//  Interfaces & Types

/** The string slots the codec reads and writes; AppStateStore implements it (the IdleSilenceStore
 * pattern), and a JVM test fakes it with a map. */
internal interface ChatPersistenceStore {
	fun saveThreads(json: String)
	fun loadThreads(): String?
	fun saveReadAnchors(json: String)
	fun loadReadAnchors(): String?
	fun saveThreadsAndReadAnchors(threadsJson: String, anchorsJson: String)
	fun saveLabels(json: String)
	fun loadLabels(): String?
	fun saveScheduledSends(json: String)
	fun loadScheduledSends(): String?
	fun saveAbsenceStreaks(json: String)
	fun loadAbsenceStreaks(): String?
	fun saveDrafts(json: String)
	fun loadDrafts(): String?
}

////////////////////////////////
//  Class

/** The JSON codec between ChatRepository's in-memory maps and the store's string slots.
 * Every save swallows its own failure (a full disk must not crash a state transition), and every
 * load drops what it cannot trust rather than surfacing it. */
internal class ChatPersistence(private val store: ChatPersistenceStore) {
	private fun threadsJson(threads: Map<String, List<Message>>): String {
		val root = JSONObject()
		for ((team, msgs) in threads) {
			val arr = JSONArray()
			for (m in msgs) {
				val obj = JSONObject().put("me", m.fromMe).put("text", m.text).put("at", m.at)
				obj.putOpt("status", m.status)
				obj.putOpt("opId", m.opId)
				if (m.epoch != 0L) obj.put("epoch", m.epoch)
				if (m.seq != 0L) obj.put("seq", m.seq)
				obj.putOpt("title", m.title)
				obj.putOpt("summary", m.summary)
				obj.putOpt("fullSpoken", m.fullSpoken)
				val (persistFrom, persistTo) = persistedAttribution(m)
				obj.putOpt("from", persistFrom)
				obj.putOpt("to", persistTo)
				if (m.isPeer) obj.put("isPeer", true)
				// Local paths and blob references only. The files themselves live on disk, not in here.
				if (m.files.isNotEmpty()) {
					val files = JSONArray()
					for (f in m.files) {
						files.put(fileJson(f))
					}
					obj.put("files", files)
				}
				arr.put(obj)
			}
			root.put(team, arr)
		}
		return root.toString()
	}

	internal fun persistThreads(threads: Map<String, List<Message>>) {
		runCatching { store.saveThreads(threadsJson(threads)) }
	}

	private fun readAnchorsJson(anchors: Map<String, ReadAnchor>): String {
		val root = JSONObject()
		for ((team, a) in anchors) {
			root.put(team, JSONObject().put("epoch", a.epoch).put("seq", a.seq).put("at", a.at))
		}
		return root.toString()
	}

	internal fun persistReadAnchors(anchors: Map<String, ReadAnchor>) {
		runCatching { store.saveReadAnchors(readAnchorsJson(anchors)) }
	}

	/** Write threads AND read anchors in one SharedPreferences batch (see
	 * AppStateStore.saveThreadsAndReadAnchors) - required whenever a single state transition
	 * changed both, so a process kill between two separate writes can never strand one against
	 * the other's stale value. */
	internal fun persistThreadsAndReadAnchors(threads: Map<String, List<Message>>, anchors: Map<String, ReadAnchor>) {
		runCatching { store.saveThreadsAndReadAnchors(threadsJson(threads), readAnchorsJson(anchors)) }
	}

	/** Load persisted read anchors, keyed by canonical address. On the FIRST run after this
	 * feature ships (no anchors persisted at all yet - `store.loadReadAnchors()` returns null),
	 * one-shot seed every EXISTING thread at its own tail, so the update does not resurrect old
	 * messages as unread; a brand-new team created afterward gets no seed and its first message
	 * badges immediately via the runtime "no anchor -> everything after it unread" rule. */
	internal fun loadPersistedReadAnchors(threads: Map<String, List<Message>>): Map<String, ReadAnchor> {
		val json = store.loadReadAnchors()
		if (json != null) {
			return runCatching {
				val root = JSONObject(json)
				buildMap {
					for (rawKey in root.keys()) {
						if (!isAddressKey(rawKey)) continue
						val a = root.getJSONObject(rawKey)
						put(rawKey, ReadAnchor(a.optLong("epoch"), a.optLong("seq"), a.optLong("at")))
					}
				}
			}.getOrDefault(emptyMap())
		}
		val seeded = threads.mapNotNull { (team, msgs) -> lastInboundAnchor(msgs)?.let { team to it } }.toMap()
		persistReadAnchors(seeded)
		return seeded
	}

	internal fun loadPersistedThreads(): Map<String, List<Message>> {
		val json = store.loadThreads() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			val merged = LinkedHashMap<String, MutableList<Message>>()
			for (rawKey in root.keys()) {
				if (!isAddressKey(rawKey)) continue
				val canonicalKey = rawKey
				val arr = root.getJSONArray(rawKey)
				val loaded = (0 until arr.length()).map {
					val m = arr.getJSONObject(it)
					val isPeer = m.optBoolean("isPeer")
					// A peer row's from/to are the same address grammar as a thread key, so validate them
					// the same way (isAddressKey) before trusting them - a corrupted store file or a future
					// grammar change must degrade to the existing unresolvable-from fallback, not surface
					// a malformed value verbatim into a notification or the thread UI.
					val (loadedFrom, loadedTo) = loadedAttribution(
						persistedFrom = m.optString("from").takeIf { s -> s.isNotEmpty() && isAddressKey(s) },
						persistedTo = m.optString("to").takeIf { s -> s.isNotEmpty() && isAddressKey(s) },
						isPeer = isPeer,
						isMe = m.optBoolean("me"),
						canonicalKey = canonicalKey,
					)
					Message(
						m.optBoolean("me"),
						m.optString("text"),
						m.optLong("at"),
						0L,
						loadFiles(m),
						m.optString("status").takeIf { s -> s.isNotEmpty() },
						m.optString("opId").takeIf { s -> s.isNotEmpty() },
						title = m.optString("title").tierOrNull(),
						summary = m.optString("summary").tierOrNull(),
						fullSpoken = m.optString("fullSpoken").tierOrNull(),
						epoch = m.optLong("epoch", 0L),
						seq = m.optLong("seq", 0L),
						from = loadedFrom,
						to = loadedTo,
						isPeer = isPeer,
					)
				}
					// Stored threads can hold a "waking" row, from when the cold-wake wait was a transcript
					// row rather than a notice card (ChatState.wakingTeams). Nothing resolves such a row,
					// so drop it. "pending" echoes WITH an opId are kept for the service's idempotent
					// reconcile; legacy ones without an opId cannot be re-sent safely, so they demote to
					// retriable here (and never strand a forever-working chip if the service fails early).
					.filterNot { !it.fromMe && it.status == "waking" }
					.map { if (it.fromMe && it.status == "pending" && it.opId == null) it.copy(status = "error") else it }
				merged.getOrPut(canonicalKey) { mutableListOf() }.addAll(loaded)
			}
			// id is not persisted; assign a dense per-thread id by time order AFTER any
			// merge, so it stays unique within the (possibly merged) thread.
			merged.mapValues { (_, msgs) -> msgs.sortedBy { it.at }.mapIndexed { i, m -> m.copy(id = i.toLong()) } }
		}.getOrDefault(emptyMap())
	}

	internal fun persistLabels(labels: Map<String, String>) {
		runCatching {
			val root = JSONObject()
			for ((team, name) in labels) root.put(team, name)
			store.saveLabels(root.toString())
		}
	}

	internal fun loadPersistedLabels(): Map<String, String> {
		val json = store.loadLabels() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			buildMap {
				for (rawKey in root.keys()) {
					if (!isAddressKey(rawKey)) continue
					put(rawKey, root.getString(rawKey))
				}
			}
		}.getOrDefault(emptyMap())
	}

	private fun scheduledSendsJson(records: Map<String, ScheduledSend>): String {
		val root = JSONObject()
		for ((team, rec) in records) {
			val files = JSONArray()
			for (f in rec.fileRefs) files.put(fileJson(f))
			root.put(
				team,
				JSONObject()
					.put("text", rec.text)
					.put("files", files)
					.put("fireAt", rec.fireAtMillis)
					.put("opId", rec.opId)
					.putOpt("targetDomainId", rec.targetDomainId)
					.put("createdAt", rec.createdAt),
			)
		}
		return root.toString()
	}

	internal fun persistScheduledSends(records: Map<String, ScheduledSend>) {
		runCatching { store.saveScheduledSends(scheduledSendsJson(records)) }
	}

	/** Same disposable storage class as drafts/labels, with no special re-provisioning survival.
	 * A corrupt or legacy-grammar row is dropped rather than risked as a
	 * bogus immediate fire (a blank opId or a non-positive fireAt reads as "already due"). Each row
	 * parses under its OWN runCatching, not one wrapping the whole loop - a single malformed team
	 * entry (a torn/partial SharedPreferences write, a future schema mismatch) must not throw away
	 * every OTHER team's still-good record too. That would not just lose data quietly: the next cold
	 * start's unconditional fireDueScheduledSends() would find nothing due and call
	 * rearmScheduledSendAlarm(), which cancels the real, still-armed AlarmManager alarm for every
	 * affected team when the map comes back smaller than it should be. */
	internal fun loadPersistedScheduledSends(): Map<String, ScheduledSend> {
		val json = store.loadScheduledSends() ?: return emptyMap()
		val root = runCatching { JSONObject(json) }.getOrNull() ?: return emptyMap()
		return buildMap {
			for (rawKey in root.keys()) {
				if (!isAddressKey(rawKey)) continue
				runCatching {
					val obj = root.getJSONObject(rawKey)
					val opId = obj.optString("opId")
					val fireAt = obj.optLong("fireAt")
					if (opId.isEmpty() || fireAt <= 0L) return@runCatching null
					ScheduledSend(
						text = obj.optString("text"),
						fileRefs = loadFiles(obj),
						fireAtMillis = fireAt,
						opId = opId,
						targetDomainId = obj.optString("targetDomainId").takeIf { it.isNotEmpty() },
						createdAt = obj.optLong("createdAt"),
					)
				}.getOrNull()?.let { put(rawKey, it) }
			}
		}
	}

	internal fun persistAbsenceStreaks(streak: Map<String, Int>) {
		runCatching {
			val root = JSONObject()
			for ((team, count) in streak) root.put(team, count)
			store.saveAbsenceStreaks(root.toString())
		}
	}

	internal fun loadPersistedAbsenceStreaks(): Map<String, Int> {
		val json = store.loadAbsenceStreaks() ?: return emptyMap()
		return runCatching {
			val root = JSONObject(json)
			buildMap {
				for (rawKey in root.keys()) {
					if (!isAddressKey(rawKey)) continue
					put(rawKey, root.optInt(rawKey, 0))
				}
			}
		}.getOrDefault(emptyMap())
	}

	/** Absent on a draft saved before locations existed, and on any file the provider named nothing
	 * usable for. Either way the row hides rather than showing a guess. */
	private fun loadLocations(obj: JSONObject): Map<String, String> {
		val raw = obj.optJSONObject("locations") ?: return emptyMap()
		return buildMap {
			for (src in raw.keys()) raw.optString(src).takeIf { it.isNotBlank() }?.let { put(src, it) }
		}
	}

	internal fun persistDrafts(records: Map<String, Draft>) {
		runCatching {
			val root = JSONObject()
			for ((team, draft) in records) {
				val files = JSONArray()
				for (f in draft.files) files.put(fileJson(f))
				val locations = JSONObject()
				for ((src, where) in draft.locations) locations.put(src, where)
				root.put(team, JSONObject().put("text", draft.text).put("files", files).put("locations", locations))
			}
			store.saveDrafts(root.toString())
		}
	}

	/** A pre-Draft persisted row is a bare JSON string (just the text); real users have saved
	 * drafts under that shape, so it loads as `Draft(text = it)` rather than being dropped. A
	 * current-shape row is an object with "text" + "files", read the same way a ScheduledSend's
	 * fileRefs are (loadFiles). Either way an entry that comes back unoccupied (empty legacy text)
	 * is dropped, matching withDraft's own sparse-map invariant. */
	internal fun loadPersistedDrafts(): Map<String, Draft> {
		val json = store.loadDrafts() ?: return emptyMap()
		val root = runCatching { JSONObject(json) }.getOrNull() ?: return emptyMap()
		return buildMap {
			for (rawKey in root.keys()) {
				if (!isAddressKey(rawKey)) continue
				runCatching {
					val obj = root.optJSONObject(rawKey)
					if (obj != null) {
						Draft(text = obj.optString("text"), files = loadFiles(obj), locations = loadLocations(obj))
					} else {
						Draft(text = root.getString(rawKey))
					}
				}.getOrNull()?.takeIf { it.isOccupied }?.let { put(rawKey, it) }
			}
		}
	}
}
