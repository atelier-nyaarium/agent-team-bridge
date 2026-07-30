package com.atelier_nyaarium.switchboard

import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * Debug-only log stream. This build writes NO on-device file. DEBUG builds buffer the last RING_CAP
 * lines and flush them to evie's POST /ingest once per poll cycle; release builds emit logcat only
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
	@Volatile private var ingestUrl: String? = null
	@Volatile private var ingestSaToken: String? = null
	@Volatile private var ingestAppToken: String? = null
	@Volatile private var ingestDevice: String? = null
	@Volatile private var ingestConversationId: String? = null
	// The ingest POST hits the K8s API server's cluster-signed cert, so a default
	// HttpsURLConnection fails the handshake against the platform trust store. Pin
	// the cluster CA the same way the relay's OkHttp client does.
	@Volatile private var ingestSslFactory: javax.net.ssl.SSLSocketFactory? = null

	fun init(context: Context) {
		val ctx = context.applicationContext
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
	}

	/**
	 * Wire up the ingest sender; call once the provisioning blob is parsed. DEBUG
	 * builds enable periodic log streaming; release builds no-op (body inside
	 * BuildConfig.DEBUG).
	 */
	fun attachIngest(prov: Provisioning) {
		if (BuildConfig.DEBUG) {
			val proxyBase = "${prov.apiUrl}/api/v1/namespaces/${prov.namespace}/services/${prov.service}:${prov.port}/proxy"
			ingestUrl = "$proxyBase/ingest"
			ingestSaToken = prov.saToken
			ingestAppToken = prov.appToken
			ingestDevice = prov.device
			ingestConversationId = prov.conversationId
			ingestSslFactory = runCatching { pinnedSocketFactory(prov.caPem) }.getOrNull()
			log("Ingest", "attached device=${prov.device} conv=${prov.conversationId} pinned=${ingestSslFactory != null}")
		}
	}

	/**
	 * Drain the ring buffer and POST it to /ingest, once per poll cycle. Swallows
	 * all errors. Release builds no-op (body inside BuildConfig.DEBUG).
	 */
	fun flushToIngest() {
		if (BuildConfig.DEBUG) {
			val url = ingestUrl ?: return
			val saToken = ingestSaToken ?: return
			val appToken = ingestAppToken ?: return
			val device = ingestDevice ?: return
			val convId = ingestConversationId ?: return

			val lines: List<String>
			synchronized(lock) {
				if (ring.isEmpty()) return
				lines = ring.toList()
				ring.clear()
			}

			runCatching {
				val body = buildIngestJson(device, convId, lines)
				val reqBody = body.toByteArray()
				val url2 = java.net.URL(url)
				val conn = url2.openConnection() as java.net.HttpURLConnection
				// Trust the cluster CA, or the HTTPS handshake to the API server fails.
				(conn as? javax.net.ssl.HttpsURLConnection)?.let { https ->
					ingestSslFactory?.let { https.sslSocketFactory = it }
				}
				conn.requestMethod = "POST"
				conn.setRequestProperty("Content-Type", "application/json")
				conn.setRequestProperty("Authorization", "Bearer $saToken")
				conn.setRequestProperty("X-Console-Bridge-Token", "Bearer $appToken")
				conn.connectTimeout = 8_000
				conn.readTimeout = 8_000
				conn.doOutput = true
				conn.outputStream.use { it.write(reqBody) }
				// Read the response code to complete the round-trip; discard the body.
				conn.responseCode
				conn.disconnect()
			}
			// On failure: lines are lost (not re-queued). Debug convenience only.
		}
	}

	fun log(tag: String, msg: String) {
		android.util.Log.d("sb/$tag", msg)
		if (BuildConfig.DEBUG) {
			val line = "${fmt.format(Date())} [$tag] $msg"
			synchronized(lock) {
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

	/** A TLS socket factory trusting ONLY the cluster CA, matching the relay's pinned
	 * OkHttp client. The default trust store rejects the cluster-signed API server. */
	private fun pinnedSocketFactory(caPem: String): javax.net.ssl.SSLSocketFactory {
		val ca = java.security.cert.CertificateFactory.getInstance("X.509")
			.generateCertificate(caPem.byteInputStream())
		val ks = java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType()).apply {
			load(null, null)
			setCertificateEntry("cluster-ca", ca)
		}
		val tmf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm())
			.apply { init(ks) }
		val sslCtx = javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
		return sslCtx.socketFactory
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
