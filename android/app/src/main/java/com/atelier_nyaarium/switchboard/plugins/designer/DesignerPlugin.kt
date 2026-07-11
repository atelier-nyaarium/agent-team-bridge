package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.ChipDecoration
import com.atelier_nyaarium.switchboard.plugins.AccountWipeHandler
import com.atelier_nyaarium.switchboard.plugins.AttachmentChipDecorator
import com.atelier_nyaarium.switchboard.plugins.AttachmentOpener
import com.atelier_nyaarium.switchboard.plugins.InboundMessageHandler
import com.atelier_nyaarium.switchboard.plugins.PluginActionHandler
import com.atelier_nyaarium.switchboard.plugins.PluginEntry
import com.atelier_nyaarium.switchboard.plugins.PluginHost
import com.atelier_nyaarium.switchboard.plugins.ThreadForgetHandler
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The Designer plugin's entry hook (manifest: `assets/plugins/designer/manifest.json`). It renders a
 * conversation's design canvases in a thread dock, opens a tapped card-marked chip into that dock's
 * viewer, and ingests each new dsCard attachment into its device store (the `DesignStore` singleton,
 * inited here with the app context so the context-free ingest handler can reach it). Forget/wipe
 * drop a conversation's / all card indexes. See CLAUDE.md "Android plugin framework".
 */
class DesignerPlugin : PluginEntry {
	override fun register(host: PluginHost) {
		DesignStore.init(host.applicationContext)
		host.threadDockSlots.claim("designer:dock") { scope -> DesignerDock(scope) }
		host.attachmentOpeners.claim("designer:card", DesignerCardOpener)
		host.threadForgetHandlers.claim("designer:forget", ThreadForgetHandler { _, team -> DesignStore.forget(team) })
		host.accountWipeHandlers.claim("designer:wipe", AccountWipeHandler { _ -> DesignStore.forgetAll() })
		// Data-plane: each new inbound dsCard upserts into the store (agent-pushed content only, so
		// skip own/peer rows). Runs on the poll thread inside the drain, so the read is bounded.
		host.inboundMessages.claim("designer:ingest", InboundMessageHandler { filesDir, msg ->
			if (msg.fromMe || msg.isPeer) return@InboundMessageHandler
			cardsFrom(msg.files, msg.at) { rel -> readCardPrefix(filesDir, rel) }
				.forEach { DesignStore.upsert(msg.team, it) }
		})
		// Agent-initiated delete via the generic plugin-action dispatch. DesignStore.delete is
		// already idempotent (a list-size check before any write), satisfying PluginActionHandler's
		// mandatory idempotency contract for free.
		host.pluginActions.claim("designer:delete-card", PluginActionHandler { action ->
			val fileName = (action.payload?.get("fileName") as? JsonPrimitive)?.contentOrNull ?: return@PluginActionHandler
			DesignStore.delete(action.team, fileName)
		})
		// The in-chat announce chip: a chip whose rel IS a card's current push shows the card's
		// title with Designer styling. Rel-keyed on purpose - an older revision of a re-pushed
		// file, a deleted card, or a non-card html all miss the store and keep the plain chip.
		// In-memory lookup only (the decorator contract; this runs per file per transcript sync).
		host.attachmentChipDecorators.claim("designer:card-title", AttachmentChipDecorator { team, file ->
			val rel = file.src?.let(::relOf)?.takeIf { it.isNotEmpty() } ?: return@AttachmentChipDecorator null
			DesignStore.cardForRel(team, rel)?.let { card -> ChipDecoration(card.displayName, "designer") }
		})
	}
}

/** Claims a tapped attachment when it is a card-marked HTML file, handing it to the live dock.
 * Runs on the tap's main thread, so it reads only a bounded prefix (the `@dsCard` marker leads the
 * file) and refuses an oversize file, so a large `.html` cannot ANR the UI or be claimed-then-not-
 * rendered (which would swallow the tap). */
private object DesignerCardOpener : AttachmentOpener {
	override fun tryOpen(context: Context, team: String, rel: String, mime: String, name: String): Boolean {
		if (!looksHtml(mime, name)) return false
		if (Attachments.resolve(context.filesDir, rel) == null) return false
		val prefix = readCardPrefix(context.filesDir, rel) ?: return false
		if (parseDsCardMarker(prefix) == null) return false
		DesignerOpenBus.request(team, rel)
		return true
	}
}
