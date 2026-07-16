package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollResult
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * MockWebServer matrix test for ConsoleClient.postEvieDirect's decode contract, pinned against a
 * real HTTP round trip - a decode-order transposition here is type-identical Kotlin that compiles
 * clean, so the build gates alone cannot catch it (console-hardening.md Phase C verification).
 */
class PostEvieDirectTest {
	private lateinit var server: MockWebServer
	private val client = OkHttpClient()

	@Before
	fun setUp() {
		server = MockWebServer()
		server.start()
	}

	@After
	fun tearDown() {
		server.shutdown()
	}

	private fun emptyJsonBody() = "{}".toRequestBody("application/json".toMediaType())

	// Prefixes fail()'s message so a test can tell "went through fail" apart from "decoded R
	// directly" even when both produce a similarly-shaped EnrollResult.
	private fun taggedFail(msg: String) = EnrollResult(ok = false, error = "FAIL:$msg")

	private fun call(logBody: Boolean = true): EnrollResult = ConsoleClient.postEvieDirect(
		client,
		server.url("/relay").toString(),
		"sa-token",
		"app-token",
		"Test",
		"case",
		emptyJsonBody(),
		logBody,
		::taggedFail,
	)

	@Test
	fun postEvieDirect_2xxDecodesTypedResultDirectly() {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		assertEquals(EnrollResult(ok = true, error = null), call())
	}

	@Test
	fun postEvieDirect_2xxUndecodableBodyFallsBackToUnexpectedResponse() {
		server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))
		assertEquals("FAIL:unexpected response (HTTP 200)", call().error)
	}

	@Test
	fun postEvieDirect_non2xxTypedBodyDecodesDirectlyBeforeBounce() {
		server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"error":"rejected"}"""))
		// No "FAIL:" prefix - proves the typed decode won over the bounce/fallback path.
		assertEquals(EnrollResult(ok = false, error = "rejected"), call())
	}

	@Test
	fun postEvieDirect_non2xxBounceErrorUsedWhenBodyIsNotTypeR() {
		server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"bounced"}"""))
		assertEquals("FAIL:bounced", call().error)
	}

	@Test
	fun postEvieDirect_non2xxNeitherShapeFallsBackToHttpCode() {
		server.enqueue(MockResponse().setResponseCode(500).setBody("internal server error"))
		assertEquals("FAIL:HTTP 500", call().error)
	}

	@Test
	fun postEvieDirect_sendsAuthHeadersAndPostsToTheGivenUrl() {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		call()
		val recorded = server.takeRequest()
		assertEquals("POST", recorded.method)
		assertEquals("/relay", recorded.path)
		assertEquals("Bearer sa-token", recorded.getHeader("Authorization"))
		assertEquals("Bearer app-token", recorded.getHeader("X-Console-Bridge-Token"))
	}

	@Test(expected = IOException::class)
	fun postEvieDirect_transportFailureRethrowsInsteadOfSwallowing() {
		val dead = MockWebServer()
		dead.start()
		val deadUrl = dead.url("/relay").toString()
		dead.shutdown()
		ConsoleClient.postEvieDirect(client, deadUrl, "sa-token", "app-token", "Test", "case", emptyJsonBody(), true, ::taggedFail)
	}

	@Test
	fun postEvieDirect_logBodyFalseNeverAffectsTheDecodedResult() {
		// logBody only gates what the resp log line shows - the decode itself must stay untouched.
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		assertEquals(EnrollResult(ok = true, error = null), call(logBody = false))
	}

	// ---- redactedBodyPreview ----

	@Test
	fun redactedBodyPreview_showsTheTruncatedBodyWhenLogBodyIsTrue() {
		val body = """{"ok":true,"saToken":"super-secret-token-value"}"""
		assertEquals(body.take(160), ConsoleClient.redactedBodyPreview(body, logBody = true))
	}

	@Test
	fun redactedBodyPreview_neverContainsTheBodyWhenLogBodyIsFalse() {
		val body = """{"ok":true,"saToken":"super-secret-token-value"}"""
		val preview = ConsoleClient.redactedBodyPreview(body, logBody = false)
		assertFalse(preview.contains("super-secret-token-value"))
		assertTrue(preview.contains("redacted"))
	}
}
