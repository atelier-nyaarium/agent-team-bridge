package com.atelier_nyaarium.switchboard

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * On-device debug log the user can pull off the console. Writes to
 * Downloads/switchboard-debug.log via MediaStore with no storage permission,
 * truncating at each app start so a sent log is one session. Lines also go to
 * logcat under the `sb/<tag>` tag.
 *
 * Logging must never crash the app, so every sink call is wrapped and failures
 * are swallowed. DEBUG builds also buffer the last RING_CAP lines and flush them
 * to evie's POST /ingest once per poll cycle. Release builds eliminate the ingest
 * path entirely (every call sits inside `if (BuildConfig.DEBUG)`).
 */
object DebugLog {
	private const val FILE_NAME = "switchboard-debug.log"
	private val lock = Any()
	private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

	@Volatile private var appContext: Context? = null

	// Cached so each append is a single openOutputStream, not a query + insert.
	@Volatile private var fileUri: Uri? = null

	////////////////////////////////
	//  DEBUG-only ingest state

	// Bounded ring buffer: last RING_CAP formatted lines, drained on each flush.
	private const val RING_CAP = 500
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
		appContext = ctx
		synchronized(lock) {
			fileUri = runCatching { freshSink(ctx) }.getOrNull()
		}
		log("DebugLog", "init build ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) sdk ${Build.VERSION.SDK_INT} debug=${BuildConfig.DEBUG}")

		// Capture an otherwise-silent crash into the same file before the app dies.
		val prev = Thread.getDefaultUncaughtExceptionHandler()
		Thread.setDefaultUncaughtExceptionHandler { thread, e ->
			runCatching { log("CRASH", "uncaught on ${thread.name}: ${e.stackTraceToString()}") }
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
		val line = "${fmt.format(Date())} [$tag] $msg\n"
		val ctx = appContext ?: return
		synchronized(lock) {
			if (BuildConfig.DEBUG) {
				ring.addLast(line.trimEnd())
				while (ring.size > RING_CAP) ring.removeFirst()
			}
			runCatching {
				val uri = fileUri
				if (uri != null) {
					ctx.contentResolver.openOutputStream(uri, "wa")?.use { it.write(line.toByteArray()) }
				}
			}
		}
	}

	/** Create (or replace) the log file and write the session header; returns its
	 * MediaStore uri, or null if it could not be created. */
	private fun freshSink(ctx: Context): Uri? {
		val header = "=== switchboard debug log; session start ${fmt.format(Date())} ===\n"
		val resolver = ctx.contentResolver
		val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

		// Drop any prior session's file so a sent log is only the current run.
		resolver.query(
			collection,
			arrayOf(MediaStore.Downloads._ID),
			"${MediaStore.Downloads.DISPLAY_NAME}=?",
			arrayOf(FILE_NAME),
			null,
		)?.use { c ->
			val idCol = c.getColumnIndexOrThrow(MediaStore.Downloads._ID)
			while (c.moveToNext()) {
				runCatching { resolver.delete(ContentUris.withAppendedId(collection, c.getLong(idCol)), null, null) }
			}
		}

		val values = ContentValues().apply {
			put(MediaStore.Downloads.DISPLAY_NAME, FILE_NAME)
			put(MediaStore.Downloads.MIME_TYPE, "text/plain")
			put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
		}
		val uri = resolver.insert(collection, values) ?: return null
		resolver.openOutputStream(uri, "wt")?.use { it.write(header.toByteArray()) }
		return uri
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
