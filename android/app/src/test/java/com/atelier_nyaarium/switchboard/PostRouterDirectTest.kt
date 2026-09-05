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

// Pin decode order with a real HTTP round trip.
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

	private fun taggedFail(msg: String) = EnrollResult(ok = false, error = "FAIL:$msg")

	private suspend fun call(logBody: Boolean = true): EnrollResult = ConsoleHttp.postRouterDirect(
		client,
		server.url("/console").toString(),
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
		val error = call().error!!
		assertTrue(error.startsWith("FAIL:") && error.contains("200"))
	}

	@Test
	fun postRouterDirect_non2xxTypedBodyDecodesDirectlyBeforeBounce() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"error":"rejected"}"""))
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
		val error = call().error!!
		assertTrue(error.startsWith("FAIL:") && error.contains("500"))
	}

	@Test
	fun postRouterDirect_sendsTheAppTokenAndPostsToTheGivenUrl() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		call()
		val recorded = server.takeRequest()
		assertEquals("POST", recorded.method)
		assertEquals("/console", recorded.path)
		assertEquals("Bearer app-token", recorded.getHeader("X-Console-Bridge-Token"))
		assertNull(recorded.getHeader("Authorization"))
	}

	@Test(expected = IOException::class)
	fun postRouterDirect_transportFailureRethrowsInsteadOfSwallowing() {
		runBlocking {
			val dead = MockWebServer()
			dead.start()
			val deadUrl = dead.url("/console").toString()
			dead.shutdown()
			ConsoleHttp.postRouterDirect(client, deadUrl, "app-token", "Test", "case", emptyJsonBody(), true, ::taggedFail)
		}
	}

	@Test
	fun postRouterDirect_logBodyFalseNeverAffectsTheDecodedResult() = runBlocking {
		server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
		assertEquals(EnrollResult(ok = true, error = null), call(logBody = false))
	}


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


	private fun relayRequest() = Request.Builder().url(server.url("/console")).post(emptyJsonBody()).build()

	@Test
	fun executeCancellable_cancellingTheJobUnwindsPromptlyInsteadOfWaitingOutTheDelay() = runBlocking {
		// Cancellation must unwind before the server delay.
		val slow = MockWebServer()
		slow.start()
		try {
			slow.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}""").setBodyDelay(30, TimeUnit.SECONDS))
			val req = Request.Builder().url(slow.url("/console")).post(emptyJsonBody()).build()
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
			// Let the request reach the server.
			delay(200)
			job.cancelAndJoin()
			val elapsedMs = (System.nanoTime() - started) / 1_000_000
			assertTrue("expected a prompt cancel unwind, took ${elapsedMs}ms", elapsedMs < 5_000)
			assertTrue("expected the suspended call to observe its own cancellation", caughtCancellation)
		} finally {
			runCatching { slow.shutdown() }
		}
	}

	@Test(expected = IOException::class)
	fun executeCancellable_delayedBodyBeyondCallTimeoutThrows() {
		runBlocking {
			server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}""").setBodyDelay(2, TimeUnit.SECONDS))
			val shortTimeoutClient = client.newBuilder().callTimeout(200, TimeUnit.MILLISECONDS).build()
			ConsoleHttp.executeCancellable(shortTimeoutClient, relayRequest())
		}
	}
}
