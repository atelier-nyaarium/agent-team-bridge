package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalResult
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** ConsoleClient's static HTTP plumbing: the pinned and public OkHttp clients, the timeout chain,
 * and the shared POST primitives. No instance state. */
internal object ConsoleHttp {
	internal val JSON = "application/json".toMediaType()

	// internal (not private): ChatRepositoryConstantsTest pins the long-poll timeout chain
	// against these from a separate test class, and FORGET_TOMBSTONE_MS derives from
	// DEFAULT_RELAY_CALL_TIMEOUT_MS below for the same reason. PINNED_READ_TIMEOUT_MS also
	// gets its own pin against the gateway's SEND_BOUND_MS, the relationship its own comment
	// on buildPinnedClient already describes.
	internal const val PINNED_CONNECT_TIMEOUT_MS = 15_000L
	internal const val PINNED_READ_TIMEOUT_MS = 35_000L
	private const val PINNED_WRITE_TIMEOUT_MS = 600_000L

	// Margin on top of a call's own read timeout to get its callTimeout: covers connect
	// + request-send + response-parse overhead beyond the read wait itself.
	internal const val CALL_TIMEOUT_MARGIN_MS = 10_000L

	// The gap between a held poll's requested hold and the read timeout that bounds it -
	// see poll()'s heldReadTimeoutMs. Named (not a bare literal) because
	// ChatRepositoryConstantsTest pins LONG_POLL_HOLD_MS + this against PROXY_CEILING_MS.
	internal const val HELD_READ_MARGIN_MS = 18_000L

	// Mirrors the apiserver proxy's own read timeout (untracked infra config, not in this
	// repo) - an infra change to that value must update this one too. The binding constraint
	// on the whole long-poll chain: the client's held read timeout must return before the
	// proxy resets the socket, pinned as LONG_POLL_HOLD_MS + HELD_READ_MARGIN_MS < this in
	// ChatRepositoryConstantsTest.
	internal const val PROXY_CEILING_MS = 60_000L

	// Bounds the common (non-held) relay() call: base read timeout + connect + margin.
	// poll()'s held branch derives its own larger callTimeoutMs from its own read timeout
	// instead of using this (see poll()). send() opts out entirely (callTimeoutMs = null)
	// since its upload body write must not be capped by an overall call duration.
	// internal (not private): ChatRepository derives FORGET_TOMBSTONE_MS from this, since
	// that tombstone must outlast the same teams() call this bounds.
	internal const val DEFAULT_RELAY_CALL_TIMEOUT_MS =
		PINNED_CONNECT_TIMEOUT_MS + PINNED_READ_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS

	/** System-trust client for the PUBLIC device-approval ingress. No CA pin (the reach URL is a real
	 * public cert) and no creds, so it is shared and built once. Short read timeout since the fresh
	 * device polls fetch in a loop. */
	private val publicClient: OkHttpClient by lazy {
		OkHttpClient.Builder()
			.connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
			.readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
			// Bounds the whole call: a fresh device polls this in a loop, so a peer
			// that trickles bytes must not hold one call open past its own read gaps.
			.callTimeout(40, java.util.concurrent.TimeUnit.SECONDS)
			.build()
	}

	/** What postEvieDirect's resp log line shows for a response body: the real (truncated) text when
	 * logBody is true, else a char-count placeholder that can never contain the body's own content -
	 * pulled out of postEvieDirect so this policy is directly unit-testable without going through
	 * DebugLog (which a pure-JVM test cannot observe). */
	internal fun loggedBodyPreview(text: String, logBody: Boolean): String =
		if (logBody) text.take(160) else "(redacted, ${text.length} chars)"

	/** A response reduced to the two things every caller here needs, read out fully before this
	 * suspend call returns. */
	internal data class HttpTextResult(val code: Int, val text: String) {
		val isSuccessful: Boolean get() = code in 200..299
	}

	/** Run [req] on [httpClient] cancellably: a coroutine cancellation calls Call.cancel() and this
	 * suspend call unwinds immediately instead of waiting out a timeout. The body is read to a String
	 * and the Response closed INSIDE the OkHttp callback, before resuming - so a cancellation racing
	 * the callback can only ever abandon an already-closed, already-read HttpTextResult, never a
	 * leaked Response, and every caller's own parsing/decoding runs after resume, on the CALLER's
	 * dispatcher, not OkHttp's callback thread. Shared by relay() and postEvieDirect() so this
	 * cancellability lands in exactly these two places. */
	internal suspend fun executeCancellable(httpClient: OkHttpClient, req: Request): HttpTextResult =
		suspendCancellableCoroutine { cont ->
			val call = httpClient.newCall(req)
			cont.invokeOnCancellation { call.cancel() }
			call.enqueue(
				object : Callback {
					override fun onResponse(call: Call, response: Response) {
						val result =
							try {
								response.use { HttpTextResult(response.code, response.body?.string().orEmpty()) }
							} catch (e: Throwable) {
								// Throwable, not Exception: a large enough body can throw OutOfMemoryError
								// during .string(), and OkHttp's dispatcher never calls onFailure once
								// onResponse has already run - an Exception-only catch would let that
								// specific Error escape uncaught, orphaning the continuation forever (the
								// hazard this wrapper exists to close, worst for send()'s callTimeoutMs=null
								// upload). Closes the common case (this one allocation fails, headroom
								// remains); under true heap exhaustion the resumeWithException call below
								// could itself throw, which is not recoverable by any wrapper.
								cont.resumeWithException(e)
								return
							}
						cont.resume(result)
					}

					override fun onFailure(call: Call, e: IOException) {
						cont.resumeWithException(e)
					}
				},
			)
		}

	/** Shared evie-direct POST: every op that bypasses relay() and talks to evie's console-bridge
	 * straight (enroll, postConsoleApproval, firstRoot, requestGatewayTransport, enrollHandshake,
	 * roster, trustHandshake, trustPending, provisionTenant) shares this exact decode contract - 2xx
	 * decodes as R (falling back through `fail` on a malformed body); non-2xx tries R first (a
	 * coordinator reject can carry a typed body), then a bare {error} bounce, then a plain HTTP-code
	 * fallback via `fail`. Takes its client/url/tokens as parameters rather than reading `this` so a
	 * MockWebServer test can drive it with no Context-backed ConsoleClient; production code never
	 * calls this directly - it goes through ConsoleClient's own instance-level `postEvieDirect(tag,
	 * describe, body, logBody, fail)`, which fills in that instance's client/url/tokens.
	 * `tag`+`describe` together must stay unique enough to disambiguate in the debug log (e.g. the
	 * Trust pair, or provisionTenant vs enroll sharing the "Enroll" tag). `logBody` gates only the
	 * resp line's body preview - requestGatewayTransport (a minted SA token) and provisionTenant (a
	 * one-time invite nonce) pass false so their 2xx bodies never reach the debug log, which the
	 * debug build ships off-device to evie /ingest as well as logcat. */
	internal suspend inline fun <reified R> postEvieDirect(
		httpClient: OkHttpClient,
		url: String,
		saToken: String,
		appToken: String,
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R {
		val req = Request.Builder()
			.url(url)
			// Empty on a direct record: that token authenticates the k8s proxy hop, not the Router.
			.apply { if (saToken.isNotEmpty()) header("Authorization", "Bearer $saToken") }
			.header("X-Console-Bridge-Token", "Bearer $appToken")
			.post(body)
			.build()
		DebugLog.log(tag, "POST $url $describe")
		val resp =
			try {
				executeCancellable(httpClient, req)
			} catch (e: Exception) {
				// A cancellation racing this call is not a transport failure - skip the log line
				// (which the debug build ships off-device) so a teardown cancel does not read as a
				// spurious connection error in the ingest stream. The rethrow is unconditional either
				// way; only the logging is skipped.
				if (e !is CancellationException) {
					DebugLog.log(tag, "$describe transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				}
				throw e
			}
		DebugLog.log(tag, "$describe resp HTTP ${resp.code} ${loggedBodyPreview(resp.text, logBody)}")
		if (resp.isSuccessful) {
			return runCatching { wireJson.decodeFromString<R>(resp.text) }
				.getOrElse { fail("unexpected response (HTTP ${resp.code})") }
		}
		runCatching { wireJson.decodeFromString<R>(resp.text) }.getOrNull()?.let { return it }
		val err = runCatching { wireJson.decodeFromString<BounceBody>(resp.text).error }.getOrNull()
		return fail(err ?: "HTTP ${resp.code}")
	}

	/** The fresh device N's public path: a plain HTTPS POST of the op JSON to evie's nonce-gated
	 * ingress, carrying NO SA token and NO app token (N holds none). Only the join/fetch steps reach
	 * here; the nonce in the op body is the gate. TLS is the public host's real cert (system trust).
	 * Always answers a ConsoleApprovalResult (the ingress returns 200 with the ok flag in the body).
	 * Deliberately NOT built on postEvieDirect: different client (publicClient, no CA pin), no auth
	 * headers, and no isSuccessful branch on the decode (the ingress always answers 200). */
	fun postPublicApproval(reachUrl: String, op: ConsoleApprovalOp): ConsoleApprovalResult {
		val req = Request.Builder()
			.url(reachUrl)
			.post(wireJson.encodeToString(ConsoleApprovalOp.serializer(), op).toRequestBody(JSON))
			.build()
		DebugLog.log("DeviceApproval", "PUBLIC POST $reachUrl step=${op::class.simpleName}")
		val resp =
			try {
				publicClient.newCall(req).execute()
			} catch (e: Exception) {
				DebugLog.log("DeviceApproval", "public transport error: ${e.javaClass.simpleName}: ${e.message?.take(140)}")
				throw e
			}
		resp.use {
			val text = resp.body?.string().orEmpty()
			DebugLog.log("DeviceApproval", "public resp HTTP ${resp.code} ${text.take(160)}")
			runCatching { wireJson.decodeFromString<ConsoleApprovalResult>(text) }.getOrNull()?.let { return it }
			return ConsoleApprovalResult(ok = false, error = "HTTP ${resp.code}")
		}
	}

	/** Trust ONLY the supplied cluster CA (the API server cert is cluster-signed). */
	internal fun buildPinnedClient(caPem: String): OkHttpClient {
		val ca = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(caPem.toByteArray()))
		val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
			load(null, null)
			setCertificateEntry("cluster-ca", ca)
		}
		val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
		val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
		val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
		// The relay holds a send op server-side for up to 25s (the gateway's
		// send bound) before answering "running", so OkHttp's 10s default read
		// timeout would mislabel every cold-wake send as failed. Write gets
		// headroom for a 500 MB attachment upload on slow links. No callTimeout here
		// deliberately: it varies per call (tight for poll/relay, unbounded for send's
		// upload), so relay() sets it per-call instead - see DEFAULT_RELAY_CALL_TIMEOUT_MS.
		return OkHttpClient.Builder()
			.sslSocketFactory(ssl.socketFactory, tm)
			.connectTimeout(PINNED_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.readTimeout(PINNED_READ_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.writeTimeout(PINNED_WRITE_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.build()
	}

	/**
	 * A client trusting EXACTLY the Router's self-signed leaf, by SHA-256 fingerprint.
	 *
	 * Hostname verification is disabled here and only here: a pinned leaf has no CA chain and no
	 * meaningful subject, which is what lets the same certificate answer on a LAN IP, a DDNS name,
	 * or a port-forwarded address without reissue. The pin is the trust, and it is delivered
	 * out-of-band in the provisioning blob. Same timeout profile as the CA-pinned client, so a
	 * held poll is not mislabelled as a failure.
	 */
	internal fun buildLeafPinnedClient(certFpHex: String): OkHttpClient {
		val tm = object : X509TrustManager {
			override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
				throw CertificateException("client authentication is not used")

			override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
				checkPinnedLeaf(chain, certFpHex)

			override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
		}
		val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }
		return OkHttpClient.Builder()
			.sslSocketFactory(ssl.socketFactory, tm)
			.hostnameVerifier { _, _ -> true }
			.connectTimeout(PINNED_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.readTimeout(PINNED_READ_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.writeTimeout(PINNED_WRITE_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
			.build()
	}
}
