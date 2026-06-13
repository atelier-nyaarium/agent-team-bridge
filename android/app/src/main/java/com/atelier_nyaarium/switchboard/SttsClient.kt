package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SttsProvider
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Client for the VRCSTT "STTS" TTS service. Provider knowledge is DATA, not
 * code: each call passes an `SttsProvider` descriptor (from the bundled
 * assets/stts-providers.json catalog) carrying the URL path and a request-body
 * TEMPLATE. This client owns only the transport - URL assembly, auth header,
 * template substitution, and streaming the bytes to a file.
 *
 * - POST /TextToSpeech/{path}/stream  -> audio streamed back
 * - POST /TextToSpeech/{path}/sample  -> short voice sample (providers without
 *   a sample route fall back to stream)
 * - GET  /health                      -> service liveness (gates the Play UI)
 * - Auth: "vrcstt-api-key" header, key from the provisioning blob (sttsKey).
 *
 * Response audio is MP3 or length-unbounded streaming WAV, always labeled
 * content-type audio/wav - the player sniffs the container, never trusts the
 * header. The descriptor's `container` field records the verified container
 * where known, but it is documentation; the player sniffs regardless.
 *
 * Blocking OkHttp like PhoneClient: callers own the dispatcher boundary.
 */
class SttsClient(private val baseUrl: String, private val apiKey: String) {
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
	 * Synthesize `text` with `provider` and write the streamed audio to `dest`.
	 * Returns the byte count. Throws with the server's error text on a non-2xx.
	 */
	fun stream(provider: SttsProvider, text: String, voice: String?, dest: File): Long =
		post("${provider.path}/stream", buildBody(provider, text, voice), dest)

	/** Short voice sample for the settings picker (providers without a sample
	 * route fall back to streaming the sample text). */
	fun sample(provider: SttsProvider, text: String, voice: String?, dest: File): Long {
		if (!provider.hasSample) return stream(provider, text, voice, dest)
		return post("${provider.path}/sample", buildBody(provider, text, voice), dest)
	}

	private fun post(pathTail: String, body: String, dest: File): Long {
		require(isConfigured) { "STTS is not provisioned (sttsUrl/sttsKey missing)" }
		val req = Request.Builder()
			.url("$baseUrl/TextToSpeech/$pathTail")
			.header("vrcstt-api-key", apiKey)
			.post(body.toRequestBody(JSON))
			.build()
		client.newCall(req).execute().use { resp ->
			if (!resp.isSuccessful) {
				error("STTS HTTP ${resp.code}: ${resp.body?.string().orEmpty().take(300)}")
			}
			val respBody = resp.body ?: error("STTS: empty body")
			dest.outputStream().use { out -> return respBody.byteStream().copyTo(out) }
		}
	}

	/** Fill the descriptor's request template: the chosen voice falls back to
	 * the descriptor default when blank. Fails loud if the template carries no
	 * "$text" placeholder (a malformed descriptor would otherwise speak
	 * nothing silently). */
	private fun buildBody(provider: SttsProvider, text: String, voice: String?): String {
		require(containsPlaceholder(provider.request, "\$text")) {
			"STTS descriptor ${provider.id} has no \$text placeholder in its request template"
		}
		val resolvedVoice = voice?.takeIf { it.isNotBlank() } ?: provider.defaults.voice
		return fillTemplate(provider.request, text, resolvedVoice).toString()
	}

	companion object {
		private val JSON = "application/json".toMediaType()

		/**
		 * Substitute placeholders in a request-body template tree. Replaces ONLY
		 * string values exactly equal to "$text" or "$voice" - whole-value match,
		 * never substring splicing - so nested objects, JSON numbers, and literal
		 * strings pass through verbatim. The serializer JSON-encodes the
		 * substituted values, so arbitrary synthesis text is never string-spliced.
		 */
		/** Whether any string VALUE in the template tree equals `placeholder`. */
		fun containsPlaceholder(node: JsonElement, placeholder: String): Boolean = when (node) {
			is JsonObject -> node.values.any { containsPlaceholder(it, placeholder) }
			is JsonArray -> node.any { containsPlaceholder(it, placeholder) }
			is JsonPrimitive -> node.isString && node.content == placeholder
		}

		fun fillTemplate(node: JsonElement, text: String, voice: String): JsonElement = when (node) {
			is JsonObject -> JsonObject(node.mapValues { fillTemplate(it.value, text, voice) })
			is JsonArray -> JsonArray(node.map { fillTemplate(it, text, voice) })
			is JsonPrimitive ->
				if (node.isString) {
					when (node.content) {
						"\$text" -> JsonPrimitive(text)
						"\$voice" -> JsonPrimitive(voice)
						else -> node
					}
				} else {
					node
				}
		}
	}
}
