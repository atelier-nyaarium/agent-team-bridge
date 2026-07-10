package com.atelier_nyaarium.switchboard.plugins.designer

import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost

/**
 * The Designer plugin's entry hook (manifest: `assets/plugins/designer/manifest.json`). One
 * contribution: the thread dock rendering a conversation's design canvases - see
 * plans/plugins.md and the approved mockups snapshotted at temp/switchboard-designer-dock/.
 */
class DesignerPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		host.threadDockSlots.claim("designer:dock") { team -> DesignerDock(team) }
	}
}
