package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for the pure voice helpers: foldConn (probe + catalog -> honest state)
 * and normalizeSttsUrl (validate/normalize the base URL before the key is ever sent
 * there). Pure-JVM (no Android); normalizeSttsUrl uses OkHttp's HttpUrl, which runs on
 * the JVM unchanged.
 */
class SttsVoiceTest {
	@Test
	fun okWithVoicesIsConnected() {
		val (state, reason) = foldConn(SttsProbe.Ok, hasVoices = true)
		assertEquals(SttsConn.CONNECTED, state)
		assertEquals("", reason)
	}

	@Test
	fun okWithoutVoicesIsNoVoices() {
		val (state, _) = foldConn(SttsProbe.Ok, hasVoices = false)
		assertEquals(SttsConn.NO_VOICES, state)
	}

	@Test
	fun unreachableIsFailedWithReason() {
		val (state, reason) = foldConn(SttsProbe.Unreachable("HTTP 401"), hasVoices = true)
		assertEquals(SttsConn.FAILED, state)
		assertEquals("HTTP 401", reason)
	}

	@Test
	fun acceptsCleanHttpsOriginAndStripsTrailingSlash() {
		assertEquals("https://vrcsttapi.azurewebsites.net", normalizeSttsUrl("https://vrcsttapi.azurewebsites.net"))
		assertEquals("https://h.example", normalizeSttsUrl("  https://h.example/  "))
	}

	@Test
	fun rejectsNonHttps() {
		assertNull(normalizeSttsUrl("http://h.example"))
	}

	@Test
	fun rejectsUserinfoHostConfusion() {
		// The attack: a real-looking name in the userinfo, host is actually evilhost.
		assertNull(normalizeSttsUrl("https://vrcsttapi.azurewebsites.net@evilhost"))
	}

	@Test
	fun rejectsPathQueryFragment() {
		assertNull(normalizeSttsUrl("https://h.example/prefix"))
		assertNull(normalizeSttsUrl("https://h.example/?x=1"))
		assertNull(normalizeSttsUrl("https://h.example/#frag"))
	}

	@Test
	fun rejectsGarbage() {
		assertNull(normalizeSttsUrl("not a url"))
		assertNull(normalizeSttsUrl(""))
	}
}
