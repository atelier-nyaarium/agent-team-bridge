package com.atelier_nyaarium.switchboard

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.NativeClipboard
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

////////////////////////////////
//  Terminal pane

internal val TERMINAL_BG = Color(0xFF0C0C0C)

@Composable
internal fun TerminalPane(
	ansi: String,
	paused: Boolean,
	onLongPress: () -> Unit,
	onResume: () -> Unit,
	modifier: Modifier = Modifier,
) {
	val annotated = remember(ansi) { ansiToAnnotated(ansi) }
	val body = @Composable {
		Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
			Text(
				text = annotated,
				modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp),
				fontFamily = FontFamily.Monospace,
				fontSize = 11.sp,
				lineHeight = 14.sp,
				color = Color(0xFFCCCCCC),
				softWrap = false,
			)
		}
	}
	Box(modifier.background(TERMINAL_BG)) {
		if (paused) {
			// Frozen frame, wrapped so text is selectable/copyable without the next peek wiping the
			// selection. A tapping the banner resumes live updates.
			//
			// The copy is where a link becomes legible to this app at all: Compose keeps the Selection
			// object internal, so nothing here can read what is under the handles until it is copied.
			// So Copy is what both arms the open button and rewrites what lands on the clipboard.
			val link = remember(ansi) { mutableStateOf<String?>(null) }
			val clipboard = LocalClipboard.current
			CompositionLocalProvider(
				LocalClipboard provides remember(clipboard, link) { LinkJoiningClipboard(clipboard, link) },
			) {
				SelectionContainer { body() }
			}
			// Stacked rather than side by side: the banner already runs most of a phone width, so a
			// second chip beside it would push one of the two off the edge.
			Column(
				Modifier.align(Alignment.TopEnd).padding(8.dp),
				verticalArrangement = Arrangement.spacedBy(6.dp),
				horizontalAlignment = Alignment.End,
			) {
				Surface(
					color = Color(0xCCD29922),
					shape = RoundedCornerShape(4.dp),
					modifier = Modifier.hapticClickable(onClick = onResume),
				) {
					Text(
						"Paused - long-press to select, tap to resume",
						Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
						color = Color.Black,
						fontSize = 10.sp,
					)
				}
				link.value?.let { OpenLinkButton(it) }
			}
		} else {
			// Long-press freezes the frame and switches to the selectable view above.
			Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onLongPress = { onLongPress() }) }) {
				body()
			}
		}
	}
}

/** Under the Paused banner once a copied selection has resolved to a link. Names the host rather
 * than the whole URL, so the owner can see WHICH link opens without the chip growing unbounded. */
@Composable
private fun OpenLinkButton(url: String) {
	val context = LocalContext.current
	Surface(
		color = Color(0xCC2472C8),
		shape = RoundedCornerShape(4.dp),
		modifier = Modifier.hapticClickable(onClick = { openSelectedLink(context, url) }),
	) {
		Text(
			"Open ${linkLabel(url)}",
			Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
			color = Color.White,
			fontSize = 10.sp,
		)
	}
}

////////////////////////////////
//  Functions & Helpers

/**
 * Hand a copied link to whatever claims its scheme, so a custom protocol one of the owner apps
 * registered opens the same as https does. Deliberately WIDER than a message link, whose openable
 * set is fixed in LinkMenu.kt: that one carries a scheme an agent wrote into a message, this one
 * carries what the owner selected by hand and read off the button before pressing it. A scheme no
 * app claims says so, rather than failing silently.
 */
private fun openSelectedLink(context: Context, url: String) {
	val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
	if (runCatching { context.startActivity(intent) }.isFailure) {
		Toast.makeText(context, "No app opens ${linkLabel(url)}", Toast.LENGTH_SHORT).show()
	}
}

/**
 * The clipboard the frozen frame copies through, so Copy yields the link itself rather than the rows
 * the pane broke it into, and reports what it found so the open button can offer the same link.
 * Provided around the SelectionContainer alone, so no other copy in the app routes through it, and a
 * selection that is not a link reaches the platform exactly as it was made.
 */
private class LinkJoiningClipboard(
	private val inner: Clipboard,
	private val found: MutableState<String?>,
) : Clipboard {
	override val nativeClipboard: NativeClipboard get() = inner.nativeClipboard

	override suspend fun getClipEntry(): ClipEntry? = inner.getClipEntry()

	override suspend fun setClipEntry(clipEntry: ClipEntry?) {
		val data = clipEntry?.clipData
		val copied = if (data != null && data.itemCount > 0) data.getItemAt(0).text?.toString() else null
		val link = copied?.let { selectedUrl(it) }
		// Cleared on a copy that is not a link: the owner has moved on to some other text, and an
		// open button still offering the previous one would act on something no longer selected.
		found.value = link
		if (link == null) {
			inner.setClipEntry(clipEntry)
		} else {
			inner.setClipEntry(ClipEntry(ClipData.newPlainText("link", link)))
		}
	}
}
