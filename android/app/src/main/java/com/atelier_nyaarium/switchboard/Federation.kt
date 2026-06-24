package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import kotlinx.coroutines.launch

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
