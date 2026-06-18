package com.atelier_nyaarium.switchboard

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import androidx.core.content.FileProvider
import java.io.File
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
	// Self-update to the SAME variant we are running: a debug build pulls
	// switchboard-debug.apk (so it keeps the ingest log stream), a release build pulls
	// switchboard-release.apk. Both are signed with the same key, so an update never
	// bounces the user across variants. Not `const` because BuildConfig.DEBUG is
	// resolved per build, not at the const-eval site.
	private val ASSET_NAME = if (BuildConfig.DEBUG) "switchboard-debug.apk" else "switchboard-release.apk"
	val RELEASE_URL =
		"https://github.com/atelier-nyaarium/switchboard/releases/download/android-app/$ASSET_NAME"

	sealed interface Result {
		data class Newer(val versionName: String?, val versionCode: Long) : Result
		data object UpToDate : Result
		data class Failed(val message: String) : Result
	}

	private val client = OkHttpClient.Builder().followRedirects(true).followSslRedirects(true).build()

	/** Download the release APK, keep it only if it beats the installed build,
	 * and launch the system installer for it. Runs on the caller's (IO) thread. */
	fun downloadAndStage(context: Context): Result {
		val dir = File(context.cacheDir, "updates").apply { mkdirs() }
		val staged = File(dir, "update.apk")
		val ok = runCatching {
			client.newCall(Request.Builder().url(RELEASE_URL).build()).execute().use { resp ->
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
		if (code <= installedVersionCode(context)) return Result.UpToDate
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
