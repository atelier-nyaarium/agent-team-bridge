package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SyncCursor
import com.atelier_nyaarium.switchboard.proto.SyncEntry
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Drives the hand-authored SyncCursor twin through the same vectors the vitest suite
 * reads (tests/fixtures/sync-cursor/vectors.json), so the twin cannot drift from the TS
 * transition rules: a differing fold (epoch flip, dedupe, gap delta) fails here.
 */
class SyncCursorVectorsTest {
	private data class E(override val seq: Long) : SyncEntry

	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("sync-cursor/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["vectors"]!!.jsonArray

	@Test
	fun cursorVectors() {
		for (v in vectors()) {
			val o = v.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val s = o["start"]!!.jsonObject
			val start = SyncCursor.of(
				s["epoch"]!!.jsonPrimitive.content.toLong(),
				s["ackedSeq"]!!.jsonPrimitive.content.toLong(),
				s["droppedBaseline"]!!.jsonPrimitive.content.toLong(),
			)
			val pr = o["pollResult"]!!.jsonObject
			val entries = pr["entries"]!!.jsonArray.map { E(it.jsonObject["seq"]!!.jsonPrimitive.content.toLong()) }
			val result = SyncPollResult(
				entries,
				pr["cursor"]!!.jsonPrimitive.content.toLong(),
				pr["epoch"]!!.jsonPrimitive.content.toLong(),
				pr["dropped"]!!.jsonPrimitive.content.toLong(),
			)
			val adv = start.advance(result)
			val ex = o["expect"]!!.jsonObject
			val exNext = ex["next"]!!.jsonObject
			assertEquals(name, exNext["epoch"]!!.jsonPrimitive.content.toLong(), adv.next.epoch)
			assertEquals(name, exNext["ackedSeq"]!!.jsonPrimitive.content.toLong(), adv.next.ackedSeq)
			assertEquals(name, exNext["droppedBaseline"]!!.jsonPrimitive.content.toLong(), adv.next.droppedBaseline)
			assertEquals(name, ex["freshSeqs"]!!.jsonArray.map { it.jsonPrimitive.content.toLong() }, adv.fresh.map { it.seq })
			assertEquals(name, ex["gap"]!!.jsonPrimitive.content.toBoolean(), adv.gap)
		}
	}

	@Test
	fun initialIsEpochZeroSentinel() {
		val c = SyncCursor.initial()
		assertEquals(0L, c.epoch)
		assertEquals(0L, c.ackedSeq)
		assertEquals(0L, c.droppedBaseline)
	}
}
