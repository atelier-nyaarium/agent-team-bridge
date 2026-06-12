package com.atelier_nyaarium.switchboard

import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Client for the VRCSTT "STTS" TTS service (OAS title VRCSTTAPI). Mapped from
 * the owner's Swagger snapshot + notes:
 *
 * - POST /TextToSpeech/{provider}/stream  -> raw WAV streamed back
 * - POST /TextToSpeech/{provider}/sample  -> short voice sample WAV (no sample
 *   route for ElevenLabs)
 * - GET  /health                          -> service liveness
 * - Auth: "vrcstt-api-key" header, key from the provisioning blob (sttsKey).
 * - Each provider takes a custom JSON body (TextToSpeech{Provider}Request).
 *   The exact per-provider fields are NOT yet confirmed (the Swagger snapshot
 *   had every schema collapsed); requestBody() ships a minimal {text, voice}
 *   default and a per-provider override point to fill in as the live spec is
 *   introspected. Keep this the ONLY place wire shapes live.
 *
 * Blocking OkHttp like PhoneClient: callers own the dispatcher boundary.
 */
class SttsClient(private val baseUrl: String, private val apiKey: String) {
	enum class Provider(val path: String, val hasSample: Boolean = true) {
		AMAZON("Amazon"),
		AZURE("Azure"),
		ELEVENLABS("ElevenLabs", hasSample = false),
		GOOGLE("Google"),
		IBM("IBM"),
		OPENAI("OpenAI"),
		UBERDUCK("Uberduck"),
		XAI("xAI"),
	}

	private val client = OkHttpClient.Builder()
		.connectTimeout(10, TimeUnit.SECONDS)
		// TTS synthesis of a multi-sentence summary can take a while; the body
		// is streamed, so the read timeout covers time-to-first-byte gaps.
		.readTimeout(60, TimeUnit.SECONDS)
		.build()

	val isConfigured: Boolean get() = baseUrl.isNotEmpty() && apiKey.isNotEmpty()

	/** Service liveness; gates the Play button's enabled state. */
	fun health(): Boolean {
		if (!isConfigured) return false
		val req = Request.Builder().url("$baseUrl/health").get().build()
		return runCatching { client.newCall(req).execute().use { it.isSuccessful } }.getOrDefault(false)
	}

	/**
	 * Synthesize `text` and write the streamed WAV to `dest`. Returns the byte
	 * count. Throws with the server's error text on a non-2xx reply.
	 */
	fun stream(provider: Provider, text: String, voice: String?, dest: File): Long {
		require(isConfigured) { "STTS is not provisioned (sttsUrl/sttsKey missing)" }
		val req = Request.Builder()
			.url("$baseUrl/TextToSpeech/${provider.path}/stream")
			.header("vrcstt-api-key", apiKey)
			.post(requestBody(provider, text, voice).toString().toRequestBody(JSON))
			.build()
		client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) {
				error("STTS ${provider.path} HTTP ${resp.code}: ${resp.body?.string().orEmpty().take(300)}")
			}
			val body = resp.body ?: error("STTS ${provider.path}: empty body")
			dest.outputStream().use { out -> return body.byteStream().copyTo(out) }
		}
	}

	/** Short voice sample for the settings picker (providers without a sample
	 * route fall back to streaming the sample text). */
	fun sample(provider: Provider, text: String, voice: String?, dest: File): Long {
		if (!provider.hasSample) return stream(provider, text, voice, dest)
		require(isConfigured) { "STTS is not provisioned (sttsUrl/sttsKey missing)" }
		val req = Request.Builder()
			.url("$baseUrl/TextToSpeech/${provider.path}/sample")
			.header("vrcstt-api-key", apiKey)
			.post(requestBody(provider, text, voice).toString().toRequestBody(JSON))
			.build()
		client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) {
				error("STTS ${provider.path} HTTP ${resp.code}: ${resp.body?.string().orEmpty().take(300)}")
			}
			val body = resp.body ?: error("STTS ${provider.path}: empty body")
			dest.outputStream().use { out -> return body.byteStream().copyTo(out) }
		}
	}

	/**
	 * Per-provider request JSON (mirrors TextToSpeech{Provider}Request). The
	 * shapes below are PLACEHOLDERS pending live-spec introspection; adjust per
	 * provider here and nowhere else. ElevenLabs is known to nest
	 * data/settings sub-objects (TextToSpeechElevenLabsRequestData/Settings).
	 */
	private fun requestBody(provider: Provider, text: String, voice: String?): JSONObject {
		val body = JSONObject().put("text", text)
		if (voice != null) body.put("voice", voice)
		return when (provider) {
			else -> body
		}
	}

	companion object {
		private val JSON = "application/json".toMediaType()
	}
}
