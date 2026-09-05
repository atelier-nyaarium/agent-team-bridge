package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalOp
import com.atelier_nyaarium.switchboard.proto.ConsoleApprovalResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
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

internal object ConsoleHttp {
	internal val JSON = "application/json".toMediaType()

	internal const val PINNED_CONNECT_TIMEOUT_MS = 15_000L
	internal const val PINNED_READ_TIMEOUT_MS = 35_000L
	private const val PINNED_WRITE_TIMEOUT_MS = 600_000L

	// Includes connection and read overhead.
	internal const val CALL_TIMEOUT_MARGIN_MS = 10_000L

	internal const val HELD_READ_MARGIN_MS = 18_000L

	// Exceeds the Router hold window.
	internal const val ROUTER_HOLD_MS = 55_000L

	internal const val DEFAULT_OWNER_OP_TIMEOUT_MS =
		PINNED_CONNECT_TIMEOUT_MS + PINNED_READ_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS

	// Public approval uses system trust.
	private val publicClient: OkHttpClient by lazy {
		OkHttpClient.Builder()
			.connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
			.readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
			.callTimeout(40, java.util.concurrent.TimeUnit.SECONDS)
			.build()
	}

	// Redact response bodies by default.
	internal fun loggedBodyPreview(text: String, logBody: Boolean): String =
		if (logBody) text.take(160) else "(redacted, ${text.length} chars)"

	internal data class HttpTextResult(val code: Int, val text: String) {
		val isSuccessful: Boolean get() = code in 200..299
	}

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
								// Body-read errors must settle the continuation.
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

	internal suspend inline fun <reified R> postRouterDirect(
		httpClient: OkHttpClient,
		url: String,
		appToken: String,
		tag: String,
		describe: String,
		body: RequestBody,
		logBody: Boolean,
		fail: (String) -> R,
	): R {
		val req = Request.Builder()
			.url(url)
			.header(Protocol.Wire.CONSOLE_TOKEN_HEADER, Protocol.Wire.BEARER_PREFIX + appToken)
			.post(body)
			.build()
		DebugLog.log(tag, "POST $url $describe")
		val resp =
			try {
				executeCancellable(httpClient, req)
			} catch (e: Exception) {
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

	// Pin the self-signed Router leaf.
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
