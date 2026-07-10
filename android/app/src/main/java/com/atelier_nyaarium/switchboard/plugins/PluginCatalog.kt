package com.atelier_nyaarium.switchboard.plugins

/**
 * The baked-in plugin list - the transform of nyaadot's filesystem discovery scan for an APK
 * (plans/plugins.md): every baked plugin's Kotlin is compiled in anyway, so discovery is this
 * compile-time table, and the scan's "manifest marks the package" invariant is enforced by a unit
 * test asserting this list and the `assets/plugins/<dir>/manifest.json` folders agree (folder
 * name = the manifest's `content_id`). Real scanning returns if dynamic install ever lands.
 *
 * Order is the boot order: a plugin must come after anything it `requires`.
 */
object PluginCatalog {
	data class Entry(
		/** Folder name under `assets/plugins/`, holding this plugin's `manifest.json`. */
		val assetDir: String,
		val entry: PluginEntry,
	)

	val all: List<Entry> = listOf(
		Entry("designer", com.atelier_nyaarium.switchboard.plugins.designer.DesignerPlugin()),
	)
}
