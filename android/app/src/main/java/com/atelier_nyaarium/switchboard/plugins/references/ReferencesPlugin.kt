package com.atelier_nyaarium.switchboard.plugins.references

import android.content.Context
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.ChipDecoration
import com.atelier_nyaarium.switchboard.plugins.AttachmentChipDecorator
import com.atelier_nyaarium.switchboard.plugins.LinkHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.TappedLink
import com.atelier_nyaarium.switchboard.proto.REF_SCHEME
import com.atelier_nyaarium.switchboard.proto.canonicalizeRefUri

/**
 * The References plugin (manifest: `assets/plugins/references/manifest.json`).
 *
 * Claims the `ref:` scheme. Every display decision is a pure read of the tapped file's own
 * wire-declared metadata: which files are machinery (`role`), and which ref keys a snapshot backs
 * (`ref.keys`). A tap resolves against the TAPPED ROW's own files, which is what gives references
 * snapshot semantics: the same ref written in two messages opens each message's own copy of the
 * file, as it was when that message was sent.
 */
class ReferencesPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		// TODO(2026-09): remove with LegacyRefMigration. The drain-time display index this store
		// backed is gone; deleting its orphaned prefs file is a no-op once it has run anywhere.
		host.applicationContext.deleteSharedPreferences("plugin-references-index")
		// A snapshot is machinery, not something the reader attached, so its chip is hidden. A pure
		// field read: no bytes, no disk, no index, no dependence on when anything landed.
		host.attachmentChipDecorators.claim("references:hide-artifacts", AttachmentChipDecorator { _, file ->
			if (file.role == "ref-snapshot") ChipDecoration("", "references", hidden = true) else null
		})
		host.linkHandlers.claim("references:ref", RefLinkHandler)
	}
}

private object RefLinkHandler : LinkHandler {
	override val scheme: String = REF_SCHEME.substringBefore("//")

	/**
	 * Open the tapped ref, or decline.
	 *
	 * Declining rather than claiming-and-doing-nothing is the miss contract: every path out of here
	 * that cannot show code returns false, so the tap falls back to the link menu with the URL
	 * visible. That covers a ref no file on this row declares, a snapshot whose bytes have not
	 * landed, and a purged attachment bucket.
	 */
	override fun tryOpen(context: Context, link: TappedLink): Boolean {
		val key = canonicalizeRefUri(link.url) ?: return false
		for (file in link.files) {
			val meta = file.ref ?: continue
			val entry = meta.keys.firstOrNull { it.key == key } ?: continue
			val src = file.src ?: return false
			val rel = src.substringAfter("attachments/", src)
			if (Attachments.resolve(context.filesDir, rel) == null) return false
			ReferenceOpenBus.request(ReferenceOpenRequest(link.team, entry, meta, rel, link.url))
			return true
		}
		return false
	}
}
