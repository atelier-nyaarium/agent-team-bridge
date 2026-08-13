package com.atelier_nyaarium.switchboard.plugins.designer

import android.content.Context
import android.widget.Toast
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.plugins.ThreadDockScope
import com.atelier_nyaarium.switchboard.saveFileToDownloads
import com.atelier_nyaarium.switchboard.send
import java.io.File
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/** The set of row/viewer actions, so the sheet's context menu and the viewer's action bar stay in
 * lockstep. Each operates on the specific card being viewed. */
internal enum class CardAction(val label: String) {
	REFERENCE("Reference in chat"),
	REATTACH("Reattach to chat"),
	DOWNLOAD("Download"),
	DELETE("Delete"),
}

/** Execute one card action; [onChanged] fires for store-mutating actions so the caller re-derives. */
internal fun runAction(
	context: Context,
	scope: ThreadDockScope,
	filesDir: File,
	card: DesignerCard,
	action: CardAction,
	onChanged: () -> Unit,
) {
	when (action) {
		CardAction.REFERENCE -> scope.insertDraftText("**${card.name}** ")
		CardAction.REATTACH -> card.rel?.let { cardFile(filesDir, it) }?.let { reattach(context, scope.team, it) }
		CardAction.DOWNLOAD -> {
			val ok = card.rel?.let { cardFile(filesDir, it) }?.let { saveFileToDownloads(context, it, card.fileName, "text/html") } ?: false
			Toast.makeText(context, if (ok) "Saved to Downloads" else "Couldn't save", Toast.LENGTH_SHORT).show()
		}
		CardAction.DELETE -> {
			// Remove from the additive index (the array shrinks). Deleting the pointer never touches the
			// message attachment; the pipeline delivered this card's message once and won't re-add it, so
			// only a strictly-newer re-push (a fresh inbound) brings the canvas back.
			DesignStore.delete(scope.team, card.fileName)
			onChanged()
		}
	}
}

/** Re-send a card's bytes as a fresh outbound attachment, reusing the composer's own send path via
 * a FileProvider URI (attachments/ is exposed in file_paths.xml). Launched on a process-lifetime
 * scope so closing the thread mid-send cannot cancel it (matching the composer's App-scoped send). */
private fun reattach(context: Context, team: String, file: File) {
	runCatching {
		val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
		designerSendScope.launch { Repo.get(context).send(team, "", listOf(uri)) }
	}
}
