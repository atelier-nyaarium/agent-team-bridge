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
	 * Per-provider request JSON (mirrors TextToSpeech{Provider}Request).
	 * Shapes confirmed by live introspection on 2026-06-12 (empty-body
	 * validation errors enumerate the required fields, then a successful
	 * synthesis per provider). `voice` maps to each provider's voice
	 * identifier; defaults are the values verified live. Response audio is MP3
	 * for Amazon/Azure/Google/xAI and length-unbounded streaming WAV for
	 * IBM/OpenAI, always labeled content-type audio/wav - let the player sniff
	 * the container, never trust the header. Uberduck needs a real
	 * voicemodel_uuid (none verified). ElevenLabs accepted the shape but
	 * streamed zero bytes on the test account.
	 */
	private fun requestBody(provider: Provider, text: String, voice: String?): JSONObject = when (provider) {
		Provider.AMAZON ->
			JSONObject().put("text", text).put("engine", "neural").put("modelId", voice ?: "Joanna")
				.put("language", "en-US")
		Provider.AZURE ->
			JSONObject().put("text", text).put("region", "eastus").put("modelId", voice ?: "en-US-JennyNeural")
				.put("language", "en-US")
		Provider.ELEVENLABS ->
			JSONObject().put("VoiceId", voice ?: "21m00Tcm4TlvDq8ikWAM").put(
				"RequestData",
				JSONObject().put("text", text).put("model_id", "eleven_multilingual_v2").put(
					"voice_settings",
					JSONObject().put("stability", 0.5).put("similarity_boost", 0.75),
				),
			)
		Provider.GOOGLE ->
			JSONObject().put("text", text).put("modelId", voice ?: "en-US-Neural2-C").put("language", "en-US")
		Provider.IBM -> JSONObject().put("text", text).put("modelId", voice ?: "en-US_AllisonV3Voice")
		Provider.OPENAI ->
			JSONObject().put("text", text).put("engine", "tts-1").put("modelId", voice ?: "alloy")
				.put("language", "en-US")
		Provider.UBERDUCK -> JSONObject().put("speech", text).put("voicemodel_uuid", voice ?: "")
		Provider.XAI -> JSONObject().put("text", text).put("language", "en-US").put("voiceId", voice ?: "Ara")
	}

	companion object {
		private val JSON = "application/json".toMediaType()
	}
}
