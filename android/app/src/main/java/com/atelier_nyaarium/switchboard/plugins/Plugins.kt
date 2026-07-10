package com.atelier_nyaarium.switchboard.plugins

import android.content.Context
import com.atelier_nyaarium.switchboard.AppStateStore

/** Process-lifetime plugin framework, mirroring [com.atelier_nyaarium.switchboard.Repo]: built
 * and booted once, surviving Activity recreation so toggling in settings never re-runs boot. */
object Plugins {
	@Volatile private var instance: PluginManager? = null

	fun get(context: Context): PluginManager =
		instance ?: synchronized(this) {
			instance ?: build(context.applicationContext).also { instance = it }
		}

	private fun build(app: Context): PluginManager {
		val runtime = PluginRuntime()
		// Core extension-point registries are created here (before boot) and exposed to plugins
		// through PluginHost; the first ones arrive with the Designer plugin.
		val host = PluginHost(runtime)
		val store = AppStateStore(app)
		val manager = PluginManager(
			runtime = runtime,
			host = host,
			enabledStore = object : PluginManager.EnabledStore {
				override fun isEnabled(id: String) = store.pluginEnabled(id)

				override fun setEnabled(id: String, on: Boolean) = store.setPluginEnabled(id, on)
			},
			readManifest = { dir -> app.assets.open("plugins/$dir/manifest.json").bufferedReader().use { it.readText() } },
			catalog = PluginCatalog.all,
			log = { com.atelier_nyaarium.switchboard.DebugLog.log("Plugins", it) },
		)
		manager.boot()
		return manager
	}
}
