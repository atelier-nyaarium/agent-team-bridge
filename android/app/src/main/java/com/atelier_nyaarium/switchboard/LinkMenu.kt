package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

////////////////////////////////
//  Functions & Helpers

/** The schemes [openLink] can actually open today. Also drives the link menu's Open button state
 * and mirrors the renderer's own standard-vs-unhandled split (markdown-link-rules.js): a scheme
 * outside this set renders as an inert red link whose menu offers Copy only. */
private val OPENABLE_SCHEMES = setOf("http", "https", "mailto")

private fun linkOpenable(url: String): Boolean = Uri.parse(url).scheme?.lowercase() in OPENABLE_SCHEMES

/** Every link activation (tap, or Open from the context menu) funnels here, keyed by scheme, so a
 * custom protocol (e.g. a host-project file reference) becomes a new branch without touching the
 * renderer or pool. `team` is the thread the link was tapped in - unused by the web schemes, but a
 * project-scoped protocol needs it to know which session's host it acts on. */
internal fun openLink(context: Context, team: String, url: String) {
	when (Uri.parse(url).scheme?.lowercase()) {
		in OPENABLE_SCHEMES -> runCatching {
			context.startActivity(
				Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
			)
		}
		else -> {}
	}
}

private fun copyLinkToClipboard(context: Context, url: String) {
	val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
	cm.setPrimaryClip(ClipData.newPlainText("link", url))
}

////////////////////////////////
//  Composables

/** The tapped-link context menu: shows the URL, with Open enabled only when the dispatcher can
 * actually open it. Composed unconditionally after the screens so it overlays them. */
@Composable
internal fun LinkMenuDialog(linkMenuState: MutableState<Pair<String, String>?>, linkMenuNoteState: MutableState<String?>) {
	val context = LocalContext.current
	var linkMenu by linkMenuState
	var linkMenuNote by linkMenuNoteState
	linkMenu?.let { (team, url) ->
		AlertDialog(
			onDismissRequest = { linkMenu = null },
			title = { Text("Link") },
			text = {
				Column {
					Text(url)
					// A claimed scheme that reached this dialog was offered to its plugin and declined,
					// so say why rather than leaving it indistinguishable from an unhandled link.
					if (linkMenuNote != null) {
						Spacer(Modifier.height(8.dp))
						Text(linkMenuNote!!, style = MaterialTheme.typography.bodySmall)
					}
				}
			},
			confirmButton = {
				// Greyed out for a scheme the dispatcher cannot open (an unhandled protocol's
				// menu is copy-only until a handler exists).
				TextButton(
					enabled = linkOpenable(url),
					onClick = hapticClick {
						openLink(context, team, url)
						linkMenu = null
					},
				) { Text("Open") }
			},
			dismissButton = {
				TextButton(onClick = hapticClick {
					copyLinkToClipboard(context, url)
					linkMenu = null
				}) { Text("Copy URL") }
			},
		)
	}
}
