package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long the values sit still before the gateway is asked to render them. */
private const val PREVIEW_SETTLE_MS = 400L

/** What the preview shows is what a fire sends, and Fire pins the revision it was shown. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunbookFireSheet(repo: ChatRepository, state: ChatState, runbookId: String, onDismiss: () -> Unit) {
	val runbook = remember(runbookId, state.runbooks) { state.runbooks.find { it.id == runbookId } }
	if (runbook == null) {
		LaunchedEffect(runbookId) { onDismiss() }
		return
	}
	val gatewayId = state.homeGatewayId
	val sheet = remember(runbookId) { FireSheetState(runbook, gatewayId) }
	LaunchedEffect(runbook.revision) { sheet.adopt(runbook) }
	val values = sheet.values
	val scope = rememberCoroutineScope()

	// An edit invalidates the preview without blanking it: the words stay, marked stale, and Fire
	// waits, so the sheet never shows nothing and never offers to send what it is showing.
	LaunchedEffect(runbook.revision, gatewayId, values) {
		sheet.preview = (sheet.preview as? PreviewState.Ready)?.let { PreviewState.Stale(it.text) }
			?: PreviewState.Pending
		delay(PREVIEW_SETTLE_MS)
		val answer = repo.runbookOps.preview(runbookId, values, gatewayId)
		sheet.preview = when {
			answer == null -> PreviewState.Unreachable(repo.runbookOps.conflictOf(runbookId)?.reason)
			answer.text != null -> PreviewState.Ready(answer.text, answer.revision)
			else -> PreviewState.Refused(answer.reason ?: "these values do not render")
		}
	}

	ModalBottomSheet(onDismissRequest = onDismiss) {
		Column(
			Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Text(runbook.name, style = MaterialTheme.typography.titleLarge)

			Column(
				Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				for (parameter in runbook.parameters) {
					val value = values[parameter.name] ?: ""
					if (parameter.kind == "choice") {
						Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
							Text(parameter.label, style = MaterialTheme.typography.labelLarge)
							FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
								for (option in parameter.options.orEmpty()) {
									FilterChip(
										selected = value == option,
										onClick = hapticClick { sheet.values = values + (parameter.name to option) },
										label = { Text(option) },
									)
								}
							}
						}
					} else {
						OutlinedTextField(
							value = value,
							onValueChange = { sheet.values = values + (parameter.name to it) },
							label = { Text(parameter.label) },
							singleLine = true,
							modifier = Modifier.fillMaxWidth(),
						)
					}
				}

				Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
					SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
						SegmentedButton(
							selected = sheet.freshSession,
							onClick = hapticClick { sheet.freshSession = true },
							shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
						) { Text("New session") }
						SegmentedButton(
							selected = !sheet.freshSession,
							onClick = hapticClick { sheet.freshSession = false },
							shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
						) { Text("Pick one") }
					}
					OutlinedTextField(
						value = sheet.target,
						onValueChange = { sheet.target = it },
						label = { Text(if (sheet.freshSession) "Start on" else "Send to") },
						singleLine = true,
						modifier = Modifier.fillMaxWidth(),
					)
				}

				PreviewPane(sheet.preview)
				sheet.refusal?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
			}

			Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
				TextButton(onClick = hapticClick(onDismiss), modifier = Modifier.weight(1f)) { Text("Cancel") }
				// The pin is the enabling condition, not just the safety net: a revision that has
				// landed but whose reset has not run yet leaves a preview of words no longer shown.
				val ready = (sheet.preview as? PreviewState.Ready)?.takeIf { it.revision == runbook.revision }
				Button(
					enabled = ready != null && !sheet.firing && sheet.target.isNotBlank(),
					onClick = hapticClick {
						val pinned = ready ?: return@hapticClick
						sheet.firing = true
						sheet.refusal = null
						scope.launch {
							val into = if (sheet.freshSession) {
								RunbookFireTarget.New(target = sheet.target, displayLabel = runbook.name)
							} else {
								RunbookFireTarget.Session(target = sheet.target)
							}
							val answer = repo.runbookOps.fire(runbookId, values, into, pinned.revision, gatewayId)
							sheet.firing = false
							if (answer?.fired == true) {
								onDismiss()
							} else {
								sheet.refusal = answer?.reason
									?: repo.runbookOps.conflictOf(runbookId)?.reason
									?: "the fire did not reach this Gateway"
							}
						}
					},
					modifier = Modifier.weight(1f),
				) { Text(if (sheet.firing) "Firing" else "Fire") }
			}
		}
	}
}

@Composable
private fun PreviewPane(preview: PreviewState) {
	val rendered = when (preview) {
		is PreviewState.Ready -> preview.text
		is PreviewState.Stale -> preview.text
		else -> null
	}
	Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
		Text(
			if (preview is PreviewState.Stale) "Preview, rendering" else "Preview",
			style = MaterialTheme.typography.labelLarge,
		)
		Surface(tonalElevation = 2.dp) {
			Column(Modifier.fillMaxWidth().padding(10.dp)) {
				when {
					rendered != null -> Text(
						rendered,
						style = MaterialTheme.typography.bodySmall,
						fontFamily = FontFamily.Monospace,
						modifier = Modifier.horizontalScroll(rememberScrollState()),
					)
					preview is PreviewState.Refused -> Text(preview.reason, style = MaterialTheme.typography.bodySmall)
					preview is PreviewState.Unreachable -> Text(
						preview.reason ?: "This Gateway did not answer",
						style = MaterialTheme.typography.bodySmall,
					)
					else -> Text("Rendering", style = MaterialTheme.typography.bodySmall)
				}
			}
		}
	}
}

/**
 * Two lifetimes, so neither can be keyed by mistake. A form belongs to a runbook at a revision and
 * `adopt` resets it. A fire in flight belongs to the sheet, or a revision landing mid-fire would
 * offer Fire again with one still going.
 */
internal class FireSheetState(runbook: Runbook, gatewayId: String) {
	var revision by mutableStateOf(runbook.revision)
		private set

	// Belongs to the runbook at a revision: a new one may declare different parameters entirely.
	var values by mutableStateOf(runbook.parameters.associate { it.name to (it.default ?: "") })
	var preview by mutableStateOf<PreviewState>(PreviewState.Pending)
	var refusal by mutableStateOf<String?>(null)

	// Belongs to the sheet. Where the owner wants it to land, and whether a fire is going, both
	// outlive an edit to the body's wording; resetting them would discard a choice for no reason.
	var freshSession by mutableStateOf(true)
	var target by mutableStateOf(gatewayId.ifBlank { "host" })
	var firing by mutableStateOf(false)

	fun adopt(runbook: Runbook) {
		if (runbook.revision == revision) return
		revision = runbook.revision
		values = runbook.parameters.associate { it.name to (it.default ?: "") }
		preview = PreviewState.Pending
		refusal = null
	}
}

internal sealed interface PreviewState {
	data object Pending : PreviewState
	/** No answer, carrying the standing conflict's reason when one explains it. */
	data class Unreachable(val reason: String?) : PreviewState
	/** The last render, kept visible while a newer one is asked for. Fire waits for it. */
	data class Stale(val text: String) : PreviewState
	data class Ready(val text: String, val revision: Long) : PreviewState
	data class Refused(val reason: String) : PreviewState
}
