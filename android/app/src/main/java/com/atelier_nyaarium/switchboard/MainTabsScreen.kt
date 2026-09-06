package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/**
 * Tab/title label for an open thread: the label when unique among open tabs, else qualified with the
 * shortest address suffix (session, then `spawn.session`, ...) that disambiguates it, e.g. "Scratch (api.claude)".
 *
 * Label uniqueness is only enforced per-spawn, so two tabs sharing a label is an expected collision, not a
 * corner case. A session with no label falls through to the bare address suffix.
 */
internal fun tabLabelFor(state: ChatState, team: String): String {
	val label = state.labelOrNull(team)
	val otherTabs = state.openTabs.filter { it != team }
	if (label != null && otherTabs.none { state.labelOrNull(it) == label }) return label
	val mine = team.split(Protocol.ADDRESS_SEP)
	val otherSegments = otherTabs.map { it.split(Protocol.ADDRESS_SEP) }
	// A label is free-form text - a user can type literal parentheses - so a qualified candidate
	// below must also be checked against every other open tab's own raw label, not just against
	// other tabs' address segments; otherwise a coincidentally (or deliberately) matching label
	// elsewhere could display identically to this tab's own disambiguated text.
	val otherLabels = otherTabs.mapNotNull { state.labelOrNull(it) }.toSet()
	fun candidateAt(n: Int): String? {
		val suffix = mine.takeLast(n)
		if (otherSegments.any { it.takeLast(n) == suffix }) return null
		val qualifier = suffix.joinToString(Protocol.ADDRESS_SEP)
		val candidate = if (label != null) "$label ($qualifier)" else qualifier
		return candidate.takeIf { it !in otherLabels }
	}
	// A present label prefers at least spawn.session (n=2): a bare session id alone (ids are random
	// hex, not a readable slug) tells a human nothing about which session,
	// defeating the point of qualifying at all. But a literal label elsewhere can coincidentally (or
	// deliberately) block every tier from spawn.session up through the full address at once - in that
	// exhausted case, retry the bare session id (n=1) as a last resort before giving up and showing
	// the tab fully unlabeled; a labeled-but-terser tab beats an unlabeled raw address every time. The
	// label-less fallback is unchanged (there is no label for an opaque id to ride alongside anyway).
	val tiers = if (label != null) (2..mine.size).toList() + 1 else (1..mine.size).toList()
	for (n in tiers) candidateAt(n)?.let { return it }
	return team
}

////////////////////////////////
//  Composables

/** The main page: one Scaffold hosting the Sessions and Task Board tabs, owning the top bar, snackbar
 * and tab selection. Back on either tab exits the app, matching every other top-level Android surface. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainTabsScreen(
	state: ChatState,
	boardEnabled: Boolean,
	snackbarHostState: SnackbarHostState,
	onRefresh: () -> Unit,
	onSettings: () -> Unit,
	// What the queue is doing at a glance, and the way in. IDLE hides the control entirely, so the
	// header never carries a button that does nothing.
	queueState: QueueGlance,
	onQueue: () -> Unit,
	sessions: @Composable (Modifier) -> Unit,
	// The second argument moves to the Sessions tab, which is where the board sends the owner after a
	// save. The pager state lives here, so the board cannot reach it any other way.
	board: @Composable (Modifier, () -> Unit) -> Unit,
	vaultEnabled: Boolean = false,
	vaultPending: Int = 0,
	vault: @Composable (Modifier) -> Unit = {},
	runbooksEnabled: Boolean = false,
	runbooks: @Composable (Modifier) -> Unit = {},
) {
	val tabs = listOf("Sessions") + (if (boardEnabled) listOf("Backlog") else emptyList()) +
		(if (runbooksEnabled) listOf("Runbooks") else emptyList()) +
		(if (vaultEnabled) listOf("Vault") else emptyList())
	val pagerState = rememberPagerState(pageCount = { tabs.size })
	val scope = rememberCoroutineScope()

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (tabs.size > 1) "Switchboard" else "Agent Sessions") },
				actions = {
					// The queue's only IN-APP door. The bubble needs an overlay grant and the transport
					// needs notifications, so a user who refuses both had no way to reach the list, the
					// pause or the skip at all - the controls existed and were unreachable.
					if (queueState != QueueGlance.IDLE) {
						IconButton(onClick = hapticClick(onQueue)) {
							// The icon says WHICH of the three states this is. A play arrow over a paused
							// run, or over a run that ended leaving messages unspoken, invites a tap that
							// means the opposite of what it looks like.
							Icon(
								when (queueState) {
									QueueGlance.ALERT -> Icons.Filled.Warning
									QueueGlance.PAUSED -> Icons.Filled.Pause
									else -> Icons.Default.PlayArrow
								},
								contentDescription = when (queueState) {
									QueueGlance.ALERT -> "Messages not spoken"
									QueueGlance.PAUSED -> "Speaking queue, paused"
									else -> "Speaking queue"
								},
							)
						}
					}
					IconButton(onClick = hapticClick(onRefresh)) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
					TextButton(onClick = hapticClick(onSettings)) { Text("Settings") }
				},
			)
		},
		snackbarHost = { SnackbarHost(snackbarHostState) },
	) { pad ->
		Column(Modifier.padding(pad).fillMaxSize()) {
			if (tabs.size > 1) {
				PrimaryTabRow(selectedTabIndex = pagerState.currentPage) {
					tabs.forEachIndexed { index, title ->
						Tab(
							selected = pagerState.currentPage == index,
							onClick = hapticClick { scope.launch { pagerState.animateScrollToPage(index) } },
							text = {
								if (title == "Vault" && vaultPending > 0) {
									BadgedBox(badge = { Badge { Text("$vaultPending") } }) { Text(title) }
								} else {
									Text(title)
								}
							},
						)
					}
				}
			}
			HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { page ->
				when (tabs[page]) {
					"Backlog" -> board(Modifier.fillMaxSize()) { scope.launch { pagerState.animateScrollToPage(0) } }
					"Runbooks" -> runbooks(Modifier.fillMaxSize())
					"Vault" -> vault(Modifier.fillMaxSize())
					else -> sessions(Modifier.fillMaxSize())
				}
			}
		}
	}
}
