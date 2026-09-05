package com.atelier_nyaarium.switchboard

import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

object DebugLog {
	private val lock = Any()
	private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
	private var initialized = false

	private const val RING_CAP = 500
	private const val CRASH_FLUSH_TIMEOUT_MS = 3_000L
	private val ring: ArrayDeque<String> = ArrayDeque(RING_CAP + 1)

	@Volatile private var ingestBase: (() -> String)? = null
	@Volatile private var ingestAppToken: String? = null
	@Volatile private var ingestDevice: String? = null
	@Volatile private var ingestConversationId: String? = null
	@Volatile private var ingestClient: okhttp3.OkHttpClient? = null
	@Volatile private var flusher: Thread? = null
	private const val FLUSH_INTERVAL_MS = 5_000L

	fun init(context: Context) {
		val ctx = context.applicationContext
		synchronized(lock) {
			if (initialized) return
			Thread { sweepSpilledLogs(ctx) }.apply { isDaemon = true }.start()
			log(
				"DebugLog",
				"init build ${BuildConfig.VERSION_NAME}+${BuildConfig.BUILD_SHA} (${BuildConfig.VERSION_CODE}) sdk ${Build.VERSION.SDK_INT} debug=${BuildConfig.DEBUG}",
			)

			val prev = Thread.getDefaultUncaughtExceptionHandler()
			Thread.setDefaultUncaughtExceptionHandler { thread, e ->
				runCatching { log("CRASH", "uncaught on ${thread.name}: ${e.stackTraceToString()}") }
				// Crash flushing is bounded to avoid delaying process death.
				runCatching {
					Thread { runCatching { flushToIngest() } }
						.apply {
							isDaemon = true
							start()
							join(CRASH_FLUSH_TIMEOUT_MS)
						}
				}
				prev?.uncaughtException(thread, e)
			}
			initialized = true
		}
	}

	fun attachIngest(prov: ConsoleCredentials, baseUrl: () -> String) {
		if (BuildConfig.DEBUG) {
			// Resolve the base URL per flush for transport failover.
			ingestBase = baseUrl
			ingestAppToken = prov.appToken
			ingestDevice = prov.device
			ingestConversationId = prov.conversationId
			ingestClient = runCatching { ConsoleHttp.buildLeafPinnedClient(prov.routerCertFp) }.getOrNull()
			val host = runCatching { java.net.URI(baseUrl()).host }.getOrNull() ?: "?"
			log("Ingest", "attached host=$host client=${ingestClient != null}")
			if (flusher == null) {
				flusher = Thread {
					while (true) {
						try {
							Thread.sleep(FLUSH_INTERVAL_MS)
						} catch (_: InterruptedException) {
							return@Thread
						}
						runCatching { flushToIngest() }
					}
				}.apply {
					isDaemon = true
					start()
				}
			}
		}
	}

	fun flushToIngest() {
		if (BuildConfig.DEBUG) {
			val url = ingestBase?.let { it().trimEnd('/') + Protocol.Wire.ROUTER_PATH_INGEST } ?: return
			val appToken = ingestAppToken ?: return
			val device = ingestDevice ?: return
			val convId = ingestConversationId ?: return

			val lines: List<String>
			synchronized(lock) {
				if (ring.isEmpty()) return
				lines = ring.toList()
				ring.clear()
			}

			val client = ingestClient ?: return
			runCatching {
				val body = buildIngestJson(device, convId, lines)
				val request =
					okhttp3.Request.Builder()
						.url(url)
						.post(body.toRequestBody("application/json".toMediaType()))
						.header(Protocol.Wire.CONSOLE_TOKEN_HEADER, Protocol.Wire.BEARER_PREFIX + appToken)
						.build()
				client.newCall(request).execute().use { android.util.Log.d("sb/Ingest", "flushed ${lines.size} lines -> HTTP ${it.code}") }
			}.onFailure { e ->
				// Failed flushes intentionally discard debug lines.
				android.util.Log.d("sb/Ingest", "flush failed: ${e::class.simpleName}: ${e.message?.take(200)}")
			}
		}
	}

	fun log(tag: String, msg: String) {
		android.util.Log.d("sb/$tag", msg)
		if (BuildConfig.DEBUG) {
			synchronized(lock) {
				val line = "${fmt.format(Date())} [$tag] $msg"
				ring.addLast(line)
				while (ring.size > RING_CAP) ring.removeFirst()
			}
		}
	}

	private val SPILL_RE = Regex("""^switchboard-debug( \(\d+\))?\.log( \(\d+\))?(\.txt)?$""")

	private fun sweepSpilledLogs(ctx: Context) {
		runCatching {
			val resolver = ctx.contentResolver
			val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
			resolver.query(
				collection,
				arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME),
				"${MediaStore.Downloads.DISPLAY_NAME} LIKE ?",
				arrayOf("switchboard-debug%"),
				null,
			)?.use { c ->
				val idCol = c.getColumnIndexOrThrow(MediaStore.Downloads._ID)
				val nameCol = c.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME)
				while (c.moveToNext()) {
					val name = c.getString(nameCol) ?: continue
					if (SPILL_RE.matches(name)) {
						runCatching {
							resolver.delete(ContentUris.withAppendedId(collection, c.getLong(idCol)), null, null)
						}
					}
				}
			}
		}
	}

	private fun buildIngestJson(device: String, convId: String, lines: List<String>): String {
		fun escape(s: String) = s
			.replace("\\", "\\\\")
			.replace("\"", "\\\"")
			.replace("\n", "\\n")
			.replace("\r", "\\r")
			.replace("\t", "\\t")
		val linesJson = lines.joinToString(",") { "\"${escape(it)}\"" }
		val at = System.currentTimeMillis()
		return """{"device":"${escape(device)}","conversationId":"${escape(convId)}","at":$at,"lines":[$linesJson]}"""
	}
}
