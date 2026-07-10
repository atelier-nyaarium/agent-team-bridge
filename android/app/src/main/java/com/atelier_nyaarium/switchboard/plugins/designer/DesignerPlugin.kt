package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.plugins.AttachmentOpener
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost

/**
 * The Designer plugin's entry hook (manifest: `assets/plugins/designer/manifest.json`). Two
 * contributions: the thread dock rendering a conversation's design canvases, and an attachment
 * opener that routes a tapped card-marked HTML chip straight into the dock's viewer. See
 * plans/plugins.md and the approved mockups at temp/switchboard-designer-dock/.
 */
class DesignerPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		host.threadDockSlots.claim("designer:dock") { scope -> DesignerDock(scope) }
		host.attachmentOpeners.claim("designer:card", DesignerCardOpener)
	}
}

/** Claims a tapped attachment when it is a card-marked HTML file, handing it to the live dock.
 * Runs on the tap's main thread, so it must NOT read the whole file: the `@dsCard` marker leads
 * the file, so a bounded prefix read is enough to decide, and a hundred-MB `.html` attachment
 * cannot ANR the UI on a tap. */
private object DesignerCardOpener : AttachmentOpener {
	private const val MARKER_PREFIX_BYTES = 2048

	override fun tryOpen(context: Context, team: String, rel: String, mime: String, name: String): Boolean {
		if (!looksHtml(mime, name)) return false
		val file = Attachments.resolve(context.filesDir, rel) ?: return false
		val prefix = runCatching {
			file.inputStream().use { it.readNBytes(MARKER_PREFIX_BYTES).toString(Charsets.UTF_8) }
		}.getOrNull() ?: return false
		if (parseDsCardMarker(prefix) == null) return false
		DesignerOpenBus.request(team, rel)
		return true
	}
}
