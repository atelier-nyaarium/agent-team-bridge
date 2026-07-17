package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Self-update by direct download from the public GitHub release. The release
 * asset is world-readable, so the app fetches it over plain HTTPS (GitHub 302s
 * to a signed CDN url, which OkHttp follows), checks the APK's versionCode
 * against the running build, and hands a newer one to the package installer.
 * No browser, no auth, no storage permissions.
 */
object AppUpdater {
	/** The variant this build is: a debug build is "debug" (it keeps the ingest log
	 * stream), a release build is "release". Both are built in the same CI run, signed
	 * with the same key, so a cross-variant install is a reinstall, not a downgrade. Not
	 * `const` because BuildConfig.DEBUG is resolved per build, not at the const-eval site. */
	fun currentVariant(): String = if (BuildConfig.DEBUG) "debug" else "release"

	private fun assetFor(variant: String) = "switchboard-$variant.apk"

	private fun urlFor(variant: String) =
		"https://github.com/atelier-nyaarium/switchboard/releases/download/android-app/${assetFor(variant)}"

	sealed interface Result {
		data class Newer(val versionName: String?, val versionCode: Long) : Result
		data object UpToDate : Result
		data class Failed(val message: String) : Result
	}

	// No callTimeout previously meant a stalled download left the Settings "Update" busy
	// spinner stuck forever (its reset only runs after the call returns). 10 minutes is
	// generous for a full APK even on a slow connection, but finite so the UI can recover.
	private val client = OkHttpClient.Builder()
		.followRedirects(true)
		.followSslRedirects(true)
		.connectTimeout(15, TimeUnit.SECONDS)
		.readTimeout(30, TimeUnit.SECONDS)
		.callTimeout(10, TimeUnit.MINUTES)
		.build()

	/** Download the chosen variant's APK, keep it only if it beats the installed build
	 * (same-variant update) or is a deliberate cross-variant flash, and launch the system
	 * installer for it. Runs on the caller's (IO) thread.
	 *
	 * The versionCode "up to date if not newer" gate applies ONLY to a same-variant update.
	 * Both variants ship from one CI run and share a versionCode, so a cross-variant fetch
	 * (debug <-> release) skips the gate and always stages: the shared signing key makes the
	 * equal-versionCode install a reinstall onto the other variant, not a downgrade. */
	fun downloadAndStage(context: Context, variant: String): Result {
		val dir = File(context.cacheDir, "updates").apply { mkdirs() }
		val staged = File(dir, "update.apk")
		val ok = runCatching {
			client.newCall(Request.Builder().url(urlFor(variant)).build()).execute().use { resp ->
				if (!resp.isSuccessful) return Result.Failed("Download failed (HTTP ${resp.code})")
				val sink = resp.body ?: return Result.Failed("Empty download")
				staged.outputStream().use { out -> sink.byteStream().use { it.copyTo(out) } }
			}
			true
		}.getOrElse { return Result.Failed(it.message ?: "Download error") }
		if (!ok) return Result.Failed("Download error")

		val info = context.packageManager.getPackageArchiveInfo(staged.path, 0)
			?: return Result.Failed("Downloaded file is not an APK")
		if (info.packageName != context.packageName) return Result.Failed("APK is for a different app")

		val code = versionCodeOf(info)
		// Only block a same-variant update that is not newer; a cross-flash is always allowed.
		if (variant == currentVariant() && code <= installedVersionCode(context)) return Result.UpToDate
		return Result.Newer(info.versionName, code)
	}

	/** Hand the staged APK to the package installer (the system "Update?" prompt). */
	fun install(context: Context) {
		val staged = File(File(context.cacheDir, "updates"), "update.apk")
		val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", staged)
		val intent = Intent(Intent.ACTION_VIEW)
			.setDataAndType(uri, "application/vnd.android.package-archive")
			.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
		runCatching { context.startActivity(intent) }
	}

	fun installedVersionCode(context: Context): Long =
		versionCodeOf(context.packageManager.getPackageInfo(context.packageName, 0))

	private fun versionCodeOf(info: PackageInfo): Long = info.longVersionCode
}
