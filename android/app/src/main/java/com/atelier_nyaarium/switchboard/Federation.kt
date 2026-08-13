package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

////////////////////////////////
//  Shared composables (used across the Users / Sharing / enroll / link surfaces)

/** A monospace, large, easy-to-read code block (the listening token / the SAS), the focal point
 * of each pairing step. */
@Composable
internal fun CodeBlock(code: String) {
	Surface(
		color = MaterialTheme.colorScheme.surfaceVariant,
		shape = MaterialTheme.shapes.medium,
		modifier = Modifier.fillMaxWidth(),
	) {
		Text(
			code,
			Modifier.padding(16.dp).fillMaxWidth(),
			fontFamily = FontFamily.Monospace,
			style = MaterialTheme.typography.headlineSmall,
			textAlign = TextAlign.Center,
		)
	}
}

/** A small inline spinner with a label, the "working..." state shared by the pairing ceremonies. */
@Composable
internal fun Busy(text: String) {
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
		CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
		Text(text, style = MaterialTheme.typography.bodyMedium)
	}
}

/** A muted info box, shared by the pairing ceremonies for guidance / status lines. */
@Composable
internal fun InfoSurface(text: String) {
	Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
		Text(text, Modifier.padding(16.dp).fillMaxWidth(), style = MaterialTheme.typography.bodySmall)
	}
}

/** Group a 6-digit safety code into two groups of three for an easy compare ("847 291"). */
internal fun grouped(code: String): String = code.chunked(3).joinToString(" ")
