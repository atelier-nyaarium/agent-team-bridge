package com.atelier_nyaarium.switchboard

import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Debug-only log stream. This build writes NO on-device file. DEBUG builds buffer the last RING_CAP
 * lines and flush them to the relay's own POST /ingest once per poll cycle; release builds emit logcat only
 * (every ring/ingest path sits inside `if (BuildConfig.DEBUG)`). Lines also go to logcat under the
 * `sb/<tag>` tag.
 *
 * Older builds spilled a Downloads/switchboard-debug.log (plus rotated and .txt variants). Since this
 * build creates none, [init] sweeps any the install still owns on EVERY start - best-effort, off the
 * main thread - so the long tail of differently-named spills clears over the next several launches.
 *
 * Logging must never crash the app, so every sink call is wrapped and failures are swallowed.
 */
object DebugLog {
	private val lock = Any()
	private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
	private var initialized = false

	////////////////////////////////
	//  DEBUG-only ingest state

	// Bounded ring buffer: last RING_CAP formatted lines, drained on each flush.
	private const val RING_CAP = 500
	// How long a dying process waits for its crash report to reach ingest. Long enough for one POST
	// on a normal connection, short enough not to hang the crash dialog on a dead network.
	private const val CRASH_FLUSH_TIMEOUT_MS = 3_000L
	// Lines waiting to be sent; guarded by `lock`.
	private val ring: ArrayDeque<String> = ArrayDeque(RING_CAP + 1)

	// Ingest endpoint params, set once provisioned. All @Volatile; written from
	// the main thread, read from the poll loop IO thread.
	@Volatile private var ingestBase: (() -> String)? = null
	@Volatile private var ingestAppToken: String? = null
	@Volatile private var ingestDevice: String? = null
	@Volatile private var ingestConversationId: String? = null
	// The relay's own pinned client (cluster CA or Router leaf), so the debug channel rides the
	// exact trust and transport the real one does.
	@Volatile private var ingestClient: okhttp3.OkHttpClient? = null

	fun init(context: Context) {
		val ctx = context.applicationContext
		// The flag publishes only after the handler is installed, or a second caller passes through
		// a DebugLog that has none. `log` re-enters this monitor, which Java allows.
		synchronized(lock) {
			if (initialized) return
			// This build writes no on-device log file; reap any older builds spilled (off-main, best-effort).
			Thread { sweepSpilledLogs(ctx) }.apply { isDaemon = true }.start()
			log(
				"DebugLog",
				"init build ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) sdk ${Build.VERSION.SDK_INT} debug=${BuildConfig.DEBUG}",
			)

			// Surface an otherwise-silent crash to logcat (and the ring, on debug) before the app dies.
			val prev = Thread.getDefaultUncaughtExceptionHandler()
			Thread.setDefaultUncaughtExceptionHandler { thread, e ->
				runCatching { log("CRASH", "uncaught on ${thread.name}: ${e.stackTraceToString()}") }
				// The ring otherwise drains only on the poll cycle, so a crash before the first poll
				// takes its own report down with the process - exactly the crash worth reading. Push it
				// out here instead, on a bounded join because the crashing thread may be the main one.
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

	/**
	 * Wire up the ingest sender; call once the provisioning blob is parsed. DEBUG
	 * builds enable periodic log streaming; release builds no-op (body inside
	 * BuildConfig.DEBUG).
	 */
	fun attachIngest(prov: Provisioning, baseUrl: () -> String) {
		if (BuildConfig.DEBUG) {
			// The base is a PROVIDER, not a value: the transport fails over between Router addresses,
			// and a flush that kept dialing the one it was attached with would die on exactly the
			// network change worth reading about.
			ingestBase = baseUrl
			ingestAppToken = prov.appToken
			ingestDevice = prov.device
			ingestConversationId = prov.conversationId
			// The SAME client the relay path uses, not a second HTTP stack with its own trust. The two
			// Android stacks reached the same host with different outcomes on one device (OkHttp
			// connected through the LAN hairpin, HttpURLConnection timed out), and a debug channel
			// that dies where the real one lives is worse than none: it says "nothing is wrong".
			ingestClient = runCatching { ConsoleHttp.buildLeafPinnedClient(prov.routerCertFp) }.getOrNull()
			val host = runCatching { java.net.URI(baseUrl()).host }.getOrNull() ?: "?"
			log("Ingest", "attached host=$host client=${ingestClient != null}")
		}
	}

	/**
	 * Drain the ring buffer and POST it to /ingest, once per poll cycle. Swallows
	 * all errors. Release builds no-op (body inside BuildConfig.DEBUG).
	 */
	fun flushToIngest() {
		if (BuildConfig.DEBUG) {
			val url = ingestBase?.let { "${it().trimEnd('/')}/ingest" } ?: return
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
						.header("X-Console-Bridge-Token", "Bearer $appToken")
						.build()
				// Read the code to complete the round-trip; discard the body. Logged straight to logcat
				// rather than through log(): a failing flush must not feed the ring it is draining.
				client.newCall(request).execute().use { android.util.Log.d("sb/Ingest", "flushed ${lines.size} lines -> HTTP ${it.code}") }
			}.onFailure { e ->
				android.util.Log.d("sb/Ingest", "flush failed: ${e::class.simpleName}: ${e.message?.take(200)}")
			}
			// On failure: lines are lost (not re-queued). Debug convenience only.
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

	// One regex for every name older builds spilled - switchboard-debug.log, .log.txt, and Android's
	// " (N)" dedup suffix in either slot:
	//   switchboard-debug.log | switchboard-debug.log.txt | switchboard-debug (1).log | switchboard-debug.log (1).txt
	private val SPILL_RE = Regex("""^switchboard-debug( \(\d+\))?\.log( \(\d+\))?(\.txt)?$""")

	/** Delete any switchboard-debug log files older builds left in Downloads. Best-effort, no storage
	 * permission (this install's owned entries only, scoped storage). Runs every start so the long tail
	 * of differently-named spills clears over the next launches; this build creates no new ones. */
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

	/** Minimal hand-rolled JSON for the ingest body; avoids kotlinx.serialization
	 * overhead and keeps DebugLog self-contained with no new imports. */
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
