package com.atelier_nyaarium.switchboard

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import org.json.JSONObject

internal enum class MutationState {
	PENDING,
	SENT,
	ACKED,
	REFUSED,
	CONFLICT,
}

internal data class MutationEntry(
	val opId: String,
	val kind: String,
	val payload: JSONObject,
	val createdAt: Long,
	val state: MutationState,
)

internal class MutationCommitException(cause: Throwable) : IOException("mutation journal commit failed", cause)

internal class MutationJournal(
	private val filesDir: File,
	private val fileName: String = "mutation-journal.jsonl",
) {
	private val file = File(filesDir, fileName)
	private val entries = linkedMapOf<String, MutationEntry>()
	private val replayed = mutableSetOf<String>()

	init {
		recover()
	}

	@Synchronized
	fun append(opId: String, kind: String, payload: JSONObject, createdAt: Long = System.currentTimeMillis()): MutationEntry {
		val entry = MutationEntry(opId, kind, JSONObject(payload.toString()), createdAt, MutationState.PENDING)
		commit(entry)
		entries[opId] = entry
		return entry
	}

	@Synchronized
	fun transition(opId: String, state: MutationState): MutationEntry {
		val prior = entries[opId] ?: error("unknown journal opId: $opId")
		val next = prior.copy(state = state, payload = JSONObject(prior.payload.toString()))
		commit(next)
		entries[opId] = next
		if (state == MutationState.ACKED || state == MutationState.REFUSED) compact()
		return next
	}

	@Synchronized
	fun pending(): List<MutationEntry> = entries.values.filter { it.state == MutationState.PENDING }

	@Synchronized
	fun claimForReplay(): List<MutationEntry> {
		val claimed = pending().filter { replayed.add(it.opId) }
		claimed.forEach { transitionWithoutCompaction(it, MutationState.SENT) }
		return claimed.map { it.copy(state = MutationState.SENT, payload = JSONObject(it.payload.toString())) }
	}

	@Synchronized
	fun compact() {
		val keep = entries.values.filterNot { it.state == MutationState.ACKED || it.state == MutationState.REFUSED }
		val temp = File(filesDir, "$fileName.tmp")
		try {
			filesDir.mkdirs()
			FileOutputStream(temp).use { output ->
				keep.forEach { output.write(line(it).toByteArray(Charsets.UTF_8)) }
				output.fd.sync()
			}
			if (!temp.renameTo(file)) error("cannot replace mutation journal")
			entries.clear()
			keep.forEach { entries[it.opId] = it }
		} catch (error: Throwable) {
			temp.delete()
			throw MutationCommitException(error)
		}
	}

	private fun recover() {
		if (!file.isFile) return
		file.forEachLine(Charsets.UTF_8) { raw ->
			if (raw.isBlank()) return@forEachLine
			val json = JSONObject(raw)
			val entry = MutationEntry(
				json.getString("opId"),
				json.getString("kind"),
				json.getJSONObject("payload"),
				json.getLong("createdAt"),
				MutationState.valueOf(json.getString("state").uppercase()),
			)
			entries[entry.opId] = entry
		}
	}

	private fun transitionWithoutCompaction(prior: MutationEntry, state: MutationState) {
		val next = prior.copy(state = state, payload = JSONObject(prior.payload.toString()))
		commit(next)
		entries[prior.opId] = next
	}

	private fun commit(entry: MutationEntry) {
		try {
			filesDir.mkdirs()
			FileOutputStream(file, true).use { output ->
				output.write(line(entry).toByteArray(Charsets.UTF_8))
				output.fd.sync()
			}
		} catch (error: Throwable) {
			throw MutationCommitException(error)
		}
	}

	private fun line(entry: MutationEntry): String = JSONObject()
		.put("opId", entry.opId)
		.put("kind", entry.kind)
		.put("payload", entry.payload)
		.put("createdAt", entry.createdAt)
		.put("state", entry.state.name.lowercase())
		.toString() + "\n"
}
