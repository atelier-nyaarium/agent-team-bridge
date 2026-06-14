package com.atelier_nyaarium.switchboard

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * On-device debug log the user can pull off the phone. Writes to the shared
 * Downloads folder as `switchboard-debug.log` (Downloads/switchboard-debug.log)
 * via MediaStore on API 29+, with no storage permission. The file is truncated at
 * each app start, then appended to, so a sent log is one session.
 *
 * Logging must never crash the app, so every sink call is wrapped and a failure is
 * swallowed. Lines also go to logcat under the `sb/<tag>` tag.
 */
object DebugLog {
	private const val FILE_NAME = "switchboard-debug.log"
	private val lock = Any()
	private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

	@Volatile private var appContext: Context? = null

	// Cached so each append is a single openOutputStream, not a query + insert.
	@Volatile private var fileUri: Uri? = null

	fun init(context: Context) {
		val ctx = context.applicationContext
		appContext = ctx
		synchronized(lock) {
			fileUri = runCatching { freshSink(ctx) }.getOrNull()
		}
		log("DebugLog", "init build ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) sdk ${Build.VERSION.SDK_INT}")

		// Capture an otherwise-silent crash into the same file before the app dies.
		val prev = Thread.getDefaultUncaughtExceptionHandler()
		Thread.setDefaultUncaughtExceptionHandler { thread, e ->
			runCatching { log("CRASH", "uncaught on ${thread.name}: ${e.stackTraceToString()}") }
			prev?.uncaughtException(thread, e)
		}
	}

	fun log(tag: String, msg: String) {
		android.util.Log.d("sb/$tag", msg)
		val line = "${fmt.format(Date())} [$tag] $msg\n"
		val ctx = appContext ?: return
		synchronized(lock) {
			runCatching {
				val uri = fileUri
				if (uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
					ctx.contentResolver.openOutputStream(uri, "wa")?.use { it.write(line.toByteArray()) }
				} else {
					legacyAppend(line)
				}
			}
		}
	}

	/** Create (or replace) the log file and write the session header; returns its
	 * MediaStore uri on API 29+, or null when the legacy file path is used. */
	private fun freshSink(ctx: Context): Uri? {
		val header = "=== switchboard debug log; session start ${fmt.format(Date())} ===\n"
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
			legacyAppend(header, truncate = true)
			return null
		}
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

	/** Pre-29 fallback: the app's external files dir needs no permission. Not the
	 * public Downloads folder, but reachable and keeps old devices from crashing. */
	private fun legacyAppend(text: String, truncate: Boolean = false) {
		val ctx = appContext ?: return
		val dir = ctx.getExternalFilesDir(null) ?: return
		FileOutputStream(File(dir, FILE_NAME), !truncate).use { it.write(text.toByteArray()) }
	}
}
