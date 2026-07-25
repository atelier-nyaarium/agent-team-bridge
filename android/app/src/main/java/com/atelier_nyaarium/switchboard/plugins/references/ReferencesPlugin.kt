package com.atelier_nyaarium.switchboard.plugins.references

import android.content.Context
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.ChipDecoration
import com.atelier_nyaarium.switchboard.plugins.AccountWipeHandler
import com.atelier_nyaarium.switchboard.plugins.AttachmentChipDecorator
import com.atelier_nyaarium.switchboard.plugins.InboundMessageHandler
import com.atelier_nyaarium.switchboard.plugins.LinkHandler
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.TappedLink
import com.atelier_nyaarium.switchboard.proto.REF_SCHEME
import com.atelier_nyaarium.switchboard.proto.canonicalizeRefUri

/**
 * The References plugin (manifest: `assets/plugins/references/manifest.json`).
 *
 * Claims the `ref:` scheme. A tap resolves against the TAPPED ROW's own manifest rather than any
 * stored index, which is what gives references snapshot semantics: the same ref written in two
 * messages opens each message's own copy of the file, as it was when that message was sent. It also
 * means a message drained before this plugin existed still opens correctly, since nothing had to be
 * recorded at the time.
 */
class ReferencesPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		RefDisplayIndex.init(host.applicationContext)
		host.linkHandlers.claim("references:ref", RefLinkHandler)
		// Drain-time seeding of the DISPLAY index. Disk is allowed here, unlike the serialization
		// site that consumes it. Reading the manifest again at tap time stays the authority, so a
		// message drained before this plugin existed still opens; it just renders plain until then.
		host.inboundMessages.claim("references:index", InboundMessageHandler { filesDir, msg ->
			val manifest = manifestFrom(filesDir, msg.files) ?: return@InboundMessageHandler
			val artifacts = (manifest.files.map { it.filename } + MANIFEST_FILENAME).toSet()
			RefDisplayIndex.record(
				msg.team,
				msg.at,
				RefDisplayIndex.Summary(
					hiddenRels = msg.files.filter { it.name in artifacts }.mapNotNull { f ->
						f.src?.let { it.substringAfter("attachments/", it) }
					}.toSet(),
					quality = manifest.refs.mapValues { (_, entry) -> entry.quality },
				),
			)
		})
		// A reference artifact is machinery, not something the reader attached, so its chip is hidden.
		host.attachmentChipDecorators.claim("references:hide-artifacts", AttachmentChipDecorator { team, file ->
			val rel = file.src?.let { it.substringAfter("attachments/", it) } ?: return@AttachmentChipDecorator null
			if (RefDisplayIndex.isArtifact(team, rel)) ChipDecoration("", "references", hidden = true) else null
		})
		host.threadForgetHandlers.claim("references:forget", ThreadForgetHandler { _, team -> RefDisplayIndex.forget(team) })
		host.accountWipeHandlers.claim("references:wipe", AccountWipeHandler { _ -> RefDisplayIndex.forgetAll() })
	}
}

private object RefLinkHandler : LinkHandler {
	override val scheme: String = REF_SCHEME.substringBefore("//")

	/**
	 * Open the tapped ref, or decline.
	 *
	 * Declining rather than claiming-and-doing-nothing is the miss contract: every path out of here
	 * that cannot show code returns false, so the tap falls back to the link menu with the URL
	 * visible. That covers a row with no manifest (a crosstalk body is never scanned, and its peer
	 * mirror carries none), a ref absent from this message's manifest, a purged attachment bucket,
	 * and a manifest that does not validate.
	 */
	override fun tryOpen(context: Context, link: TappedLink): Boolean {
		val key = canonicalizeRefUri(link.url) ?: return false
		val manifest = manifestFrom(context.filesDir, link.files) ?: return false
		val entry = manifest.refs[key] ?: return false
		val file = manifest.files.firstOrNull { it.refPath == entry.refPath } ?: return false

		val src = link.files.firstOrNull { it.name == file.filename }?.src ?: return false
		val rel = src.substringAfter("attachments/", src)
		if (Attachments.resolve(context.filesDir, rel) == null) return false

		ReferenceOpenBus.request(ReferenceOpenRequest(link.team, entry, file, rel, link.url))
		return true
	}
}
