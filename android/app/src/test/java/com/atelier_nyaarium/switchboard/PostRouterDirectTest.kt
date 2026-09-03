package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollResult
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * MockWebServer matrix test for ConsoleHttp.postRouterDirect's decode contract, pinned against a
 * real HTTP round trip - a decode-order transposition here is type-identical Kotlin that compiles
 * clean, so the build gates alone cannot catch it (console-hardening.md Phase C verification).
 * Also covers executeCancellable's cancellation and per-call-timeout behavior (Phase D).
 */
class PostRouterDirectTest {
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

	private suspend fun call(logBody: Boolean = true): EnrollResult = ConsoleHttp.postRouterDirect(
		client,
		server.url("/relay").toString(),
		"app-token",
		"Test",
		"case",
		emptyJsonBody(),
		logBody,
		::taggedFail,
	)

	@Test
	fun postRouterDirect_2xxDecodesTypedResultDirectly() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		assertEquals(EnrollResult(ok = true, error = null), call())
	}

	@Test
	fun postRouterDirect_2xxUndecodableBodyFallsBackToUnexpectedResponse() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))
		assertEquals("FAIL:unexpected response (HTTP 200)", call().error)
	}

	@Test
	fun postRouterDirect_non2xxTypedBodyDecodesDirectlyBeforeBounce() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"error":"rejected"}"""))
		// No "FAIL:" prefix - proves the typed decode won over the bounce/fallback path.
		assertEquals(EnrollResult(ok = false, error = "rejected"), call())
	}

	@Test
	fun postRouterDirect_non2xxBounceErrorUsedWhenBodyIsNotTypeR() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"bounced"}"""))
		assertEquals("FAIL:bounced", call().error)
	}

	@Test
	fun postRouterDirect_non2xxNeitherShapeFallsBackToHttpCode() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(500).setBody("internal server error"))
		assertEquals("FAIL:HTTP 500", call().error)
	}

	@Test
	fun postRouterDirect_sendsTheAppTokenAndPostsToTheGivenUrl() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		call()
		val recorded = server.takeRequest()
		assertEquals("POST", recorded.method)
		assertEquals("/console", recorded.path)
		assertEquals("Bearer app-token", recorded.getHeader("X-Console-Bridge-Token"))
		// The Router gates on the app token alone; nothing carries a second credential.
		assertNull(recorded.getHeader("Authorization"))
	}

	@Test(expected = IOException::class)
	fun postRouterDirect_transportFailureRethrowsInsteadOfSwallowing() {
		// Block body: a JUnit4 @Test method must compile to a void JVM method, and an expression
		// body here would infer a non-Unit return type from postRouterDirect's own result.
		runBlocking {
			val dead = MockWebServer()
			dead.start()
			val deadUrl = dead.url("/relay").toString()
			dead.shutdown()
			ConsoleHttp.postRouterDirect(client, deadUrl, "app-token", "Test", "case", emptyJsonBody(), true, ::taggedFail)
		}
	}

	@Test
	fun postRouterDirect_logBodyFalseNeverAffectsTheDecodedResult() = runBlocking {
		// logBody only gates what the resp log line shows - the decode itself must stay untouched.
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		assertEquals(EnrollResult(ok = true, error = null), call(logBody = false))
	}

	// ---- loggedBodyPreview ----

	@Test
	fun loggedBodyPreview_showsTheTruncatedBodyWhenLogBodyIsTrue() {
		val body = """{"ok":true,"saToken":"super-secret-token-value"}"""
		assertEquals(body.take(160), ConsoleHttp.loggedBodyPreview(body, logBody = true))
	}

	@Test
	fun loggedBodyPreview_neverContainsTheBodyWhenLogBodyIsFalse() {
		val body = """{"ok":true,"saToken":"super-secret-token-value"}"""
		val preview = ConsoleHttp.loggedBodyPreview(body, logBody = false)
		assertFalse(preview.contains("super-secret-token-value"))
		assertTrue(preview.contains("redacted"))
	}

	// ---- executeCancellable (Phase D: cancellability) ----

	private fun relayRequest() = Request.Builder().url(server.url("/relay")).post(emptyJsonBody()).build()

	@Test
	fun executeCancellable_cancellingTheJobUnwindsPromptlyInsteadOfWaitingOutTheDelay() = runBlocking {
		// A dedicated server (not the shared `server` field): the cancelled call abandons an
		// in-flight 30s-delayed dispatch server-side, which tearDown()'s shutdown of the SHARED
		// server should never have to wait out.
		val slow = MockWebServer()
		slow.start()
		try {
			// The server holds the response far longer than any reasonable test timeout; a correct
			// cancellable wrapper unwinds on cancel long before this delay would ever elapse.
			slow.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}""").setBodyDelay(30, TimeUnit.SECONDS))
			val req = Request.Builder().url(slow.url("/relay")).post(emptyJsonBody()).build()
			var caughtCancellation = false
			val started = System.nanoTime()
			val job = launch(Dispatchers.IO) {
				try {
					ConsoleHttp.executeCancellable(client, req)
				} catch (e: CancellationException) {
					caughtCancellation = true
					throw e
				}
			}
			delay(200) // let the call actually reach the server before cancelling it
			job.cancelAndJoin()
			val elapsedMs = (System.nanoTime() - started) / 1_000_000
			assertTrue("expected a prompt cancel unwind, took ${elapsedMs}ms", elapsedMs < 5_000)
			assertTrue("expected the suspended call to observe its own cancellation", caughtCancellation)
		} finally {
			// The abandoned 30s dispatch may still be draining; a slow or failing shutdown here is
			// expected and irrelevant to what this test verifies.
			runCatching { slow.shutdown() }
		}
	}

	@Test(expected = IOException::class)
	fun executeCancellable_delayedBodyBeyondCallTimeoutThrows() {
		// Block body (not `= runBlocking { ... }`): an expression body would infer this public
		// test function's return type from executeCancellable's own internal-visibility result.
		runBlocking {
			server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}""").setBodyDelay(2, TimeUnit.SECONDS))
			val shortTimeoutClient = client.newBuilder().callTimeout(200, TimeUnit.MILLISECONDS).build()
			ConsoleHttp.executeCancellable(shortTimeoutClient, relayRequest())
		}
	}
}
