package com.atelier_nyaarium.switchboard

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class FixtureDraws private constructor(
	val composer: String,
	val case: String,
) {
	private var index = 0
	private val seen = mutableSetOf<String>()
	private val recorded = linkedMapOf<String, String>()

	fun next(size: Int): ByteArray {
		require(size in 1..32) { "fixture draws require 1 to 32 bytes" }
		val n = index++
		val bytes = MessageDigest.getInstance("SHA-256")
			.digest("kotlin:$composer:$case:$n".toByteArray())
			.copyOf(size)
			.also { require(seen.add(Base64.getEncoder().encodeToString(it))) { "duplicate fixture draw" } }
		recorded[n.toString()] = Base64.getEncoder().encodeToString(bytes)
		return bytes
	}

	fun nextB64(size: Int): String = Base64.getEncoder().encodeToString(next(size))

	fun recordedB64(index: Int): String = recorded.getValue(index.toString())

	fun inputs(extra: kotlinx.serialization.json.JsonObject? = null) = buildJsonObject {
		extra?.forEach { (key, value) -> put(key, value) }
		put("draws", buildJsonObject { recorded.forEach { (key, value) -> put(key, value) } })
	}

	companion object {
		fun forCase(composer: String, case: String): FixtureDraws = FixtureDraws(composer, case)
	}
}
