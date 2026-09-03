package com.atelier_nyaarium.switchboard

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
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
	private val beforeJournalReplace: () -> Unit = {},
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
		if (state == MutationState.ACKED || state == MutationState.REFUSED || state == MutationState.CONFLICT) compact()
		return next
	}

	@Synchronized
	fun pending(): List<MutationEntry> = entries.values.filter { it.state == MutationState.PENDING }

	/** Replay PENDING and SENT entries before live sends. */
	@Synchronized
	fun claimForReplay(): List<MutationEntry> {
		val unsettled = entries.values.filter { it.state == MutationState.PENDING || it.state == MutationState.SENT }
		val claimed = unsettled.filter { replayed.add(it.opId) }
		claimed.forEach { transitionWithoutCompaction(it, MutationState.SENT) }
		return claimed.map { it.copy(state = MutationState.SENT, payload = JSONObject(it.payload.toString())) }
	}

	@Synchronized
	fun compact() {
		val keep = entries.values.filterNot {
			it.state == MutationState.ACKED || it.state == MutationState.REFUSED || it.state == MutationState.CONFLICT
		}
		val temp = File(filesDir, "$fileName.tmp")
		try {
			filesDir.mkdirs()
			FileOutputStream(temp).use { output ->
				keep.forEach { output.write(line(it).toByteArray(Charsets.UTF_8)) }
				// Fsync before replacement.
				output.fd.sync()
			}
				replaceJournal(temp)
				entries.clear()
				keep.forEach { entries[it.opId] = it }
				replayed.retainAll(keep.mapTo(mutableSetOf()) { it.opId })
		} catch (error: Throwable) {
			temp.delete()
			throw MutationCommitException(error)
		}
	}

	/** Recover readable lines. */
	private fun recover() {
		if (!file.isFile) return
		val text = file.readText(Charsets.UTF_8)
		val rawLines = text.split('\n')
		val readable = mutableListOf<String>()
		val corrupt = mutableListOf<String>()
		for ((index, raw) in rawLines.withIndex()) {
			if (raw.isBlank()) continue
			val entry = runCatching {
				val json = JSONObject(raw)
				MutationEntry(
					json.getString("opId"),
					json.getString("kind"),
					json.getJSONObject("payload"),
					json.getLong("createdAt"),
					MutationState.valueOf(json.getString("state").uppercase()),
					)
			}.getOrNull()
			if (entry == null) {
				if (index == rawLines.lastIndex && !text.endsWith('\n')) continue
				corrupt += raw
			} else {
				entries[entry.opId] = entry
				readable += raw
			}
		}
		if (corrupt.isNotEmpty()) {
			File(filesDir, "$fileName.corrupt-${System.currentTimeMillis()}").writeText(corrupt.joinToString("\n") + "\n")
		}
		if (corrupt.isNotEmpty() || (text.isNotEmpty() && !text.endsWith('\n'))) {
			val temp = File(filesDir, "$fileName.tmp")
			try {
				FileOutputStream(temp, false).use { output ->
					if (readable.isNotEmpty()) output.write((readable.joinToString("\n") + "\n").toByteArray(Charsets.UTF_8))
					output.fd.sync()
				}
				replaceJournal(temp)
			} catch (error: Throwable) {
				temp.delete()
				throw MutationCommitException(error)
			}
		}
		if (corrupt.isNotEmpty()) DebugLog.log("Journal", "set aside ${corrupt.size} corrupt line(s) on recover")
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
				// Fsync before acknowledging the commit.
				output.fd.sync()
			}
		} catch (error: Throwable) {
			throw MutationCommitException(error)
		}
	}

	private fun replaceJournal(temp: File) {
		beforeJournalReplace()
		if (!temp.renameTo(file)) error("cannot replace mutation journal")
		FileChannel.open(filesDir.toPath(), StandardOpenOption.READ).use { it.force(true) }
	}

	private fun line(entry: MutationEntry): String = JSONObject()
		.put("opId", entry.opId)
		.put("kind", entry.kind)
		.put("payload", entry.payload)
		.put("createdAt", entry.createdAt)
		.put("state", entry.state.name.lowercase())
		.toString() + "\n"
}
