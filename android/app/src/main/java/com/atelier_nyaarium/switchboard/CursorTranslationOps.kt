package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.longOrNull

internal class CursorTranslationOps(
	private val coordinator: ConsoleTransportCoordinator,
	private val journal: MutationJournal,
	private val address: () -> String,
	private val heldCursor: () -> Pair<Long, Long>,
	private val sign: (JsonObject, String) -> com.atelier_nyaarium.switchboard.proto.OwnerOp?,
	private val send: suspend (com.atelier_nyaarium.switchboard.proto.OwnerOp) -> kotlinx.serialization.json.JsonElement?,
	private val reportError: (String) -> Unit,
	private val commit: (Long, Long, Long) -> Boolean,
	private val ambient: PhoneAmbient,
) {
	suspend fun onWelcome(gen: Long, migrationEpoch: Long, welcomeCursor: Long? = null, welcomeEpoch: Long? = null) {
		if (migrationEpoch == 0L || !coordinator.owns(gen)) return
		val held = heldCursor()
		val fromEpoch = welcomeEpoch ?: held.first
		val fromSeq = welcomeCursor ?: held.second
		val prior = journal.entries("cursor_translation").lastOrNull { entry ->
			val p = entry.payload
			p.optLong("migrationEpoch", 0L) == migrationEpoch &&
				p.optLong("fromEpoch", 0L) == fromEpoch && p.optLong("fromSeq", 0L) == fromSeq
		}
		if (prior != null) {
			if (coordinator.owns(gen)) commit(
				gen,
				prior.payload.getLong("toSeq"),
				prior.payload.getLong("toEpoch"),
			)
			return
		}
		if (fromEpoch == migrationEpoch) return
		val opId = ambient.newOpId()
		val op = buildJsonObject {
			put("kind", Protocol.Wire.OWNER_OP_CURSOR_TRANSLATE)
			put("address", address())
			put("epoch", fromEpoch)
			put("seq", fromSeq)
		}
		if (!coordinator.owns(gen)) return
		val answer = send(sign(op, opId) ?: return) ?: return
		if (!coordinator.owns(gen)) return
		val translation = runCatching { answer.jsonObject["translation"]?.jsonObject }.getOrNull()
		val kind = translation?.get("kind")?.jsonPrimitive?.content
		if (kind != "translated") {
			if (kind == "unmapped") reportError("Cursor translation is unavailable for epoch $fromEpoch")
			return
		}
		val toEpoch = translation["cursor"]?.jsonObject?.get("epoch")?.jsonPrimitive?.longOrNull ?: return
		val toSeq = translation["cursor"]?.jsonObject?.get("seq")?.jsonPrimitive?.longOrNull ?: return
		journal.append(
			"translation-$migrationEpoch-$fromEpoch-$fromSeq",
			"cursor_translation",
			org.json.JSONObject()
				.put("migrationEpoch", migrationEpoch)
				.put("fromEpoch", fromEpoch)
				.put("fromSeq", fromSeq)
				.put("toEpoch", toEpoch)
				.put("toSeq", toSeq),
		)
		if (coordinator.owns(gen)) commit(gen, toSeq, toEpoch)
	}
}
