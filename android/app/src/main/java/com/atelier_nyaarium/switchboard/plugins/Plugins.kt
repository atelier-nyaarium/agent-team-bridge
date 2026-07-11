package com.atelier_nyaarium.switchboard.plugins

import android.content.Context
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.InboundSubscriber
import com.atelier_nyaarium.switchboard.PluginActionSubscriber
import com.atelier_nyaarium.switchboard.Repo

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
		val host = PluginHost(runtime, app)
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
		// Bridge the repo's data-plane fan-out into the plugin registry, ONCE per process (this build
		// runs once). Maps each raw Message to a coordinate-free InboundMessage and delivers to every
		// currently-claimed handler (a disabled plugin's claim is swept, so it stops receiving).
		Repo.get(app).addInboundSubscriber(
			InboundSubscriber { team, msg ->
				val inbound = InboundMessage(team, msg.fromMe, msg.isPeer, msg.at, msg.files, msg.text)
				host.inboundMessages.values().forEach { handler ->
					runCatching { handler.onMessage(app.filesDir, inbound) }
						.onFailure { com.atelier_nyaarium.switchboard.DebugLog.log("Plugins", "inbound handler threw: $it") }
				}
			},
		)
		// Bridge plugin-action entries the same way: dispatch to the ONE handler claimed under the
		// exact "pluginId:actionType" key (a registry claim is unique, so at most one handler ever
		// exists for a given key); an unclaimed key is silently skipped.
		Repo.get(app).addPluginActionSubscriber(
			PluginActionSubscriber { team, pluginId, actionType, payload ->
				host.pluginActions.get("$pluginId:$actionType")?.let { handler ->
					runCatching { handler.onAction(PluginAction(team, payload)) }
						.onFailure { com.atelier_nyaarium.switchboard.DebugLog.log("Plugins", "plugin action handler threw: $it") }
				}
			},
		)
		return manager
	}
}
