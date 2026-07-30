package com.atelier_nyaarium.switchboard

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Round-trips the shape every file-list writer shares. A field lost across a process death renders
 * once and then vanishes, so the assertion is the round trip rather than the serialized keys. */
class MessageFileRoundTripTest {
	private fun roundTrip(files: List<MessageFile>): List<MessageFile> {
		val arr = JSONArray()
		for (f in files) arr.put(fileJson(f))
		val reparsed = JSONObject(JSONObject().put("files", arr).toString())
		return loadFiles(reparsed)
	}

	@Test
	fun carriesEveryFieldAcrossARestart() {
		val original = MessageFile("shot.png", "image/png", "attachments/1-2/shot.png", 4096L, 1785179969544L)
		assertEquals(listOf(original), roundTrip(listOf(original)))
	}

	@Test
	fun keepsAnEpochStampAboveIntRange() {
		val restored = roundTrip(listOf(MessageFile("a.txt", "text/plain", null, 1L, 1785179969544L)))
		assertEquals(1785179969544L, restored[0].modifiedAt)
	}

	@Test
	fun absentSizeAndDateStayAbsentRatherThanBecomingZero() {
		// optLong answers 0 for a missing key, which would render as "0 B" and 1 Jan 1970 on every
		// row persisted before these fields existed.
		val restored = roundTrip(listOf(MessageFile("old.txt", "text/plain", "attachments/1-2/old.txt")))
		assertNull(restored[0].size)
		assertNull(restored[0].modifiedAt)
	}

	@Test
	fun readsALegacyRowWrittenBeforeTheFieldsExisted() {
		val legacy = JSONObject(
			"""{"files":[{"name":"old.txt","mime":"text/plain","src":"attachments/1-2/old.txt"}]}""",
		)
		val restored = loadFiles(legacy)
		assertEquals("old.txt", restored[0].name)
		assertNull(restored[0].size)
		assertNull(restored[0].modifiedAt)
	}

	@Test
	fun treatsAnExplicitJsonNullAsAbsent() {
		// `putOpt` never writes a null, so nothing this app persists exercises the isNull branch, but
		// a row hand-edited or written by an older shape can still carry one.
		val withNulls = JSONObject(
			"""{"files":[{"name":"a.txt","mime":"text/plain","size":null,"modifiedAt":null}]}""",
		)
		val restored = loadFiles(withNulls)
		assertNull(restored[0].size)
		assertNull(restored[0].modifiedAt)
	}

	@Test
	fun skipsAnUnreadableEntryInsteadOfLosingTheWholeList() {
		// The threads loader catches around its entire key loop, so a throw here would cost every
		// thread on the device rather than one row.
		val mixed = JSONObject(
			"""{"files":["oops",{"name":"real.txt","mime":"text/plain"},null]}""",
		)
		val restored = loadFiles(mixed)
		assertEquals(1, restored.size)
		assertEquals("real.txt", restored[0].name)
	}

	@Test
	fun readsAGarbledNumberAsAbsentRatherThanZero() {
		val garbled = JSONObject(
			"""{"files":[{"name":"a.txt","mime":"text/plain","size":"huge","modifiedAt":{}}]}""",
		)
		val restored = loadFiles(garbled)
		assertNull(restored[0].size)
		assertNull(restored[0].modifiedAt)
	}

	@Test
	fun keepsAZeroSizeDistinctFromNoSize() {
		val restored = roundTrip(listOf(MessageFile("empty.log", "text/plain", null, 0L)))
		assertEquals(0L, restored[0].size)
	}
}
