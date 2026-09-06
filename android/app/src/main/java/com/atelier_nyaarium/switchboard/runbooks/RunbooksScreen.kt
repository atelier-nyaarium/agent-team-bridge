package com.atelier_nyaarium.switchboard.runbooks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.Runbook

@Composable
fun RunbooksScreen(
	repo: ChatRepository,
	state: ChatState,
	onFire: (String) -> Unit,
	onEdit: (String?) -> Unit,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(state.homeGatewayId) { repo.runbookOps.refresh() }

	Box(modifier.fillMaxSize()) {
		if (state.runbooks.isEmpty()) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				Text("No runbooks", style = MaterialTheme.typography.titleMedium)
			}
		} else {
			LazyColumn(
				modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
				verticalArrangement = Arrangement.spacedBy(10.dp),
				contentPadding = PaddingValues(top = 12.dp, bottom = 88.dp),
			) {
				for (runbook in state.runbooks) {
					item(key = "runbook:${runbook.id}") {
						RunbookRow(runbook, onFire = { onFire(runbook.id) }, onEdit = { onEdit(runbook.id) })
					}
				}
			}
		}
		FloatingActionButton(
			onClick = hapticClick { onEdit(null) },
			modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
		) { Icon(Icons.Default.Add, contentDescription = "New runbook") }
	}
}

@Composable
private fun RunbookRow(runbook: Runbook, onFire: () -> Unit, onEdit: () -> Unit) {
	Card(Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit))) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(runbook.name, style = MaterialTheme.typography.titleMedium)
					Text(
						summaryOf(runbook.body),
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
				Button(onClick = hapticClick(onFire)) { Text("Fire") }
			}
			if (runbook.parameters.isNotEmpty()) {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					for (parameter in runbook.parameters) {
						AssistChip(
							onClick = {},
							enabled = false,
							label = { Text(parameter.label) },
							colors = AssistChipDefaults.assistChipColors(),
						)
					}
				}
			}
		}
	}
}

/** The first line the owner wrote, which is what they recognise a runbook by. */
internal fun summaryOf(body: String): String =
	body.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: ""
