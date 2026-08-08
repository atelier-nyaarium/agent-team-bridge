package com.atelier_nyaarium.switchboard

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceSession
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

////////////////////////////////
//  Functions & Helpers

/** Live first, then most recent activity, then label, within each section. */
internal fun sessionOrder(state: ChatState): Comparator<Team> =
	compareByDescending<Team> { it.isLive }
		.thenByDescending { state.lastActivity(it.name) ?: 0L }
		.thenBy { state.label(it.name) }

/** This device's own Domain's sessions, excluding a linked friend's, which render in the "Linked
 * friends" section instead - excluding them here is what keeps a peer session from rendering twice. */
internal fun localSessions(sessions: List<Team>, adminDomainId: String): List<Team> =
	sessions.filter { it.domainId.isNullOrEmpty() || it.domainId == adminDomainId }

/** A linked friend's Gateway is content-untrusted, so nothing enforces (gatewayId, team) uniqueness
 * in its session list; a duplicate crashes the "Linked friends" LazyColumn. Keeps the first occurrence. */
internal fun dedupedFriendSessions(sessions: List<CrossDomainPresenceSession>): List<CrossDomainPresenceSession> =
	sessions.distinctBy { it.gatewayId to it.team }

/**
 * My own Domain id, learned from a local session. Mirrors ChatRepository.confirmedDomainId()'s predicate exactly.
 *
 * Requires the matched entry to carry a domainId (not just a matching gatewayId), so a domainId-less entry
 * sharing the local gatewayId can never mask a later, real one.
 */
internal fun adminDomainId(sessions: List<Team>, localGatewayId: String): String =
	sessions
		.firstOrNull { (it.gatewayId.ifEmpty { localGatewayId }) == localGatewayId && !it.domainId.isNullOrEmpty() }
		?.domainId.orEmpty()

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
) {
	val tabs = if (boardEnabled) listOf("Sessions", "Task Board") else listOf("Sessions")
	val pagerState = rememberPagerState(pageCount = { tabs.size })
	val scope = rememberCoroutineScope()

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (boardEnabled) "Switchboard" else "Agent Sessions") },
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
							text = { Text(title) },
						)
					}
				}
			}
			HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { page ->
				if (page == 0) sessions(Modifier.fillMaxSize())
				else board(Modifier.fillMaxSize()) { scope.launch { pagerState.animateScrollToPage(0) } }
			}
		}
	}
}

@Composable
fun SessionsScreen(
	state: ChatState,
	onRefresh: () -> Unit,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onOpen: (String) -> Unit,
	onRename: (String, String) -> Unit,
	onForget: (String) -> Unit,
	onSpawn: (String, String, String?) -> Unit,
	onListDirs: suspend (String) -> List<String> = { emptyList() },
	onVerifyEnroll: (() -> Unit)? = null,
	// The board's live line per session card; { null } keeps every card's ordinary ladder.
	boardLine: (Team) -> BoardLiveLine? = { null },
	boardBranch: (Team) -> com.atelier_nyaarium.switchboard.board.CardBranch? = { null },
	// How many unfinished board entries this session holds, and the forget that first decides what
	// becomes of them. Zero keeps the plain forget confirm.
	undoneFor: (Team) -> Int = { 0 },
	onForgetWithTasks: (String, Boolean) -> Unit = { _, _ -> },
	modifier: Modifier = Modifier,
) {
	// Long-press flow: action menu -> rename dialog or forget confirm.
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	// Tapping a Gateway's Create button opens the new-session dialog with that Gateway's selectable
	// projects (host first, then its catalog devcontainer projects).
	var createDialogProjects by remember { mutableStateOf<List<String>?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }
	// Per-Gateway accordion collapse state (default expanded). rememberSaveable, not remember: the
	// pager disposes this page whenever the board tab is showing, and a plain remember would
	// silently re-expand every section on the way back.
	val collapsedGateways = rememberSaveable { mutableStateOf(setOf<String>()) }

	actionTeam?.let { team ->
		SessionActionsDialog(
			label = state.label(team.name),
			canRename = team.kind != "devcontainer",
			onRename = {
				actionTeam = null
				renameTeam = team
			},
			onForget = {
				actionTeam = null
				forgetTeam = team
			},
			onDismiss = { actionTeam = null },
		)
	}
	renameTeam?.let { team ->
		RenameDialog(
			team = team.shortName,
			current = state.label(team.name),
			onSave = {
				onRename(team.name, it)
				renameTeam = null
			},
			onDismiss = { renameTeam = null },
		)
	}
	forgetTeam?.let { team ->
		// Forgetting a session with unfinished board work BLOCKS on a decision rather than offering
		// an undo: an action button on a transient is too easy to double-tap into. Skipped entirely
		// when nothing is undone, so the prompt always means something was actually at stake.
		val undone = undoneFor(team)
		if (undone > 0) {
			BoardForgetDialog(
				label = state.label(team.name),
				undone = undone,
				onCancelTasks = {
					onForgetWithTasks(team.name, true)
					forgetTeam = null
				},
				onUnassign = {
					onForgetWithTasks(team.name, false)
					forgetTeam = null
				},
				onDismiss = { forgetTeam = null },
			)
		} else {
			ConfirmDialog(
				title = "Forget ${state.label(team.name)}?",
				body = "Drops this thread, its label, and unread state from this device.",
				confirmText = "Forget",
				onConfirm = {
					onForget(team.name)
					forgetTeam = null
				},
				onDismiss = { forgetTeam = null },
			)
		}
	}
	createDialogProjects?.let { projects ->
		CreateSessionDialog(
			projects = projects,
			pendingSpawns = state.pendingSpawns,
			onListDirs = onListDirs,
			onSpawn = { project, session, workdir ->
				onSpawn(project, session, workdir)
				createDialogProjects = null
			},
			onDismiss = { createDialogProjects = null },
		)
	}

	Column(modifier.fillMaxSize()) {
		val sessions = state.sessions()
			// Computed here (rather than calling ChatRepository.confirmedDomainId(), which this
			// Composable has no access to) so both linkedDomains and the local/peer session split below
			// share one value.
			val adminDomainId = adminDomainId(sessions, state.localGatewayId)
			val local = localSessions(sessions, adminDomainId)
			// Linked friend Domains, independent of whether discovery has surfaced any of their
			// sessions yet (see LinkedDomain's own doc - a just-linked friend must still show up). Must
			// stay unconditional: a freshly-linked friend can be known purely through state.linkedPeerOwners
			// (the trust roster) before this device has created its own first local session at all, i.e.
			// exactly while adminDomainId is still "" - a guard here would hide every linked friend in
			// that state, not just a hypothetically misclassified local one.
			val linkedDomains = CrossDomainLink.mergeLinkedDomains(state.teams, state.linkedPeerOwners, adminDomainId)
			// One status surface: when the board is empty, EmptyBoard owns the whole message, so the
			// health banner shows only ALONGSIDE real content and can never contradict the body. Mirrors
			// EmptyBoard's own negated gate rather than raw `sessions` - `linkedDomains` can be non-empty
			// purely from state.linkedPeerOwners (a linked friend known before this device's own first
			// local session exists), a case raw `sessions.isNotEmpty()` would miss entirely.
			if (local.isNotEmpty() || linkedDomains.isNotEmpty()) HealthHeader(state)
			if (state.gap) {
				Surface(
					color = MaterialTheme.colorScheme.errorContainer,
					modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
					shape = MaterialTheme.shapes.medium,
				) {
					Text(
						"Some messages were dropped. Pull history from your Gateway to recover.",
						Modifier.padding(12.dp),
						color = MaterialTheme.colorScheme.onErrorContainer,
						style = MaterialTheme.typography.bodySmall,
					)
				}
			}
			if (local.isEmpty() && linkedDomains.isEmpty()) {
				// Offer the still-owed in-person compare only on the awaiting-host board (a freshly-rooted
				// enrollee who has not finished the trust step); EmptyBoard gates the button on that state.
				EmptyBoard(state, onManage, onAddGateway, onHostHelp, onRefresh, onVerifyEnroll = onVerifyEnroll)
			} else {
				// One shared sweep phase for every card's working/verifying pulse bar, instead of each
				// card driving its own infinite animation.
				val pulsePhase = rememberSessionsPulsePhase()
				val order = sessionOrder(state)
				// Ticks every 30s so a linked friend's freshness chip re-evaluates from elapsed time
				// alone - otherwise it only recomputes when some OTHER ChatState field changes, and a
				// friend who has gone fully quiet (no more pushes or backstop pulls landing) would
				// freeze at its last-computed verdict indefinitely. Paused while backgrounded (mirroring
				// this file's own visibility-driven pattern elsewhere): delay() is wall-clock scheduled,
				// not frame-clock, so it keeps firing on schedule regardless of window visibility unless
				// explicitly paused. Reads state.foreground (kept Compose-reactive by onForeground()/
				// onBackground() for exactly this purpose) rather than opening a second, independent
				// LocalLifecycleOwner subscription alongside the app-wide one that already drives it.
				var freshnessNow by remember { mutableStateOf(System.currentTimeMillis()) }
				LaunchedEffect(linkedDomains.isNotEmpty(), state.foreground) {
					if (linkedDomains.isEmpty() || !state.foreground) return@LaunchedEffect
					while (true) {
						// Ticks immediately on (re)start, not just after the first 30s - otherwise a
						// resume from background shows a verdict frozen at its pre-background value for
						// up to 30s more, exactly when a liveness indicator is most likely checked.
						freshnessNow = System.currentTimeMillis()
						delay(30_000)
					}
				}
				// Grouped by the owning (Domain, Gateway) pair. Within each group: devcontainer projects,
				// then loose sessions. The local Gateway sorts first; peer Domains follow, ordered by Domain.
				val byGateway = local
					.groupBy { GatewayGroupKey(it.domainId.orEmpty().ifEmpty { adminDomainId }, it.gatewayId.ifEmpty { state.localGatewayId }) }
					.toList()
					.sortedBy { (key, _) ->
						if (key.domainId == adminDomainId && key.gatewayId == state.localGatewayId) "" else "${key.domainId}/${key.gatewayId}"
					}
				LazyColumn(
					Modifier.fillMaxSize(),
					contentPadding = PaddingValues(12.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
				) {
					for ((key, group) in byGateway) {
						val composite = "${key.domainId}/${key.gatewayId}"
						val collapsed = composite in collapsedGateways.value
						// A peer Domain (a linked friend's) is labeled domain/gateway so a colliding
						// gateway id reads distinctly; my own Domain shows the bare gateway id. Always
						// false in practice now that `byGateway` groups `local` (peer rows already
						// filtered out above) - left in place as a direct, defensive match of the same
						// admin-domain test used to build localSessions, rather than assuming this loop
						// can never see a non-local group.
						val isPeer = key.domainId.isNotEmpty() && adminDomainId.isNotEmpty() && key.domainId != adminDomainId
						val headerName = if (isPeer) composite else key.gatewayId
						// Only your own Gateway can ever create a session on it (host-spawn is meaningless on
						// a peer's machine), so the header's Create button and its project list are scoped the
						// same way. Computed unconditionally (not gated on `collapsed`) so the button and its
						// project list are correct even while the section is collapsed.
						val showCreate = !isPeer && key.gatewayId == state.localGatewayId
						fun localName(t: Team) = t.shortName
						val spawnPoints = group.filter { it.kind == "devcontainer" }.sortedWith(order)
						item(key = "sw:$composite") {
							GatewayHeader(
								name = headerName,
								online = group.any { it.isLive },
								collapsed = collapsed,
								onToggle = {
								val open = collapsedGateways.value
								collapsedGateways.value = if (collapsed) open - composite else open + composite
							},
								showCreate = showCreate,
								onCreate = {
									// "host" first (the synthetic spawn point below), then catalog devcontainer
									// projects; a real project literally named "host" is deduped against it.
									createDialogProjects =
										listOf("host") + spawnPoints.map { localName(it) }.filterNot { it == "host" }
								},
							)
						}
						if (!collapsed) {
							// Clean break: a devcontainer entry is a non-chat SPAWN-POINT (its bare project);
							// each project.session is a loose chat that nests under its project's header. The
							// remaining non-composite loose peers (host-loose, etc.) stay flat.
							val composites = group.filter { it.kind != "devcontainer" && isComposite(localName(it)) }
							val flatLoose =
								group.filter { it.kind != "devcontainer" && !isComposite(localName(it)) }.sortedWith(order)
							val byProject = composites.groupBy { parseSessionName(localName(it)).project }
							val spawnKeys = spawnPoints.map { localName(it) }.toSet()

							// A spawn-point header only shows once it has a session nested under it - an empty
							// one adds nothing to look at, and every project (host included) is always still
							// reachable as a Create option regardless of whether it currently has any sessions.
							fun renderProject(projectKey: String, header: @Composable () -> Unit) {
								val sessions = byProject[projectKey].orEmpty().sortedWith(order)
								if (sessions.isEmpty()) return
								// Keyed by gateway too: one LazyColumn spans every gateway, and a spawn name is
								// unique only within one, so two gateways with a `host` spawn threw on a duplicate key.
								item(key = "spawn:$composite/$projectKey") { header() }
								items(sessions, key = { "team:${it.name}" }) { team ->
									SessionCard(
										state = state,
										team = team,
										nested = true,
										pulsePhase = pulsePhase,
										boardLine = boardLine(team),
									boardBranch = boardBranch(team),
										onClick = hapticClick { onOpen(team.name) },
										onLongPress = { actionTeam = team },
									)
								}
							}

							// The host machine is a spawn point too, but it is not in the catalog (and the
							// daemon's reserved "host" slot is hidden), so it's shown synthetically for YOUR OWN
							// gateway only. Rendered first, ahead of the devcontainer spawn-points.
							if (showCreate) {
								renderProject("host") {
									SpawnPointHeader(project = "host", online = byProject["host"].orEmpty().any { it.isLive })
								}
							}
							for (sp in spawnPoints) {
								val proj = localName(sp)
								renderProject(proj) {
									SpawnPointHeader(
										project = proj,
										// A spawn-point is always available itself; its dot reflects whether any
										// session nested under it is live.
										online = byProject[proj].orEmpty().any { it.isLive },
									)
								}
							}
							// A composite whose spawn-point is not currently in the catalog still needs a home
							// (excluding "host" when it was shown above, to avoid a duplicate header).
							val orphanProjects = byProject.keys - spawnKeys - (if (showCreate) setOf("host") else emptySet())
							for (proj in orphanProjects.sorted()) {
								renderProject(proj) {
									SpawnPointHeader(project = proj, online = false)
								}
							}
							items(flatLoose, key = { "team:${it.name}" }) { team ->
								SessionCard(
									state = state,
									team = team,
									pulsePhase = pulsePhase,
									boardLine = boardLine(team),
									boardBranch = boardBranch(team),
									onClick = hapticClick { onOpen(team.name) },
									onLongPress = { actionTeam = team },
								)
							}
						}
					}
					if (linkedDomains.isNotEmpty()) {
						item(key = "linked-friends-label") { SectionLabel("Linked friends") }
						for (friend in linkedDomains) {
							val friendKey = "friend:${friend.domainId}"
							val collapsed = friendKey in collapsedGateways.value
							val entry = state.crossDomainPeerSessions[friend.domainId]
							val freshness = crossDomainFreshness(entry?.lastRefreshedAt, freshnessNow)
							val friendSessions = dedupedFriendSessions(entry?.sessions.orEmpty())
							item(key = "sw:$friendKey") {
								LinkedFriendHeader(
									name = friend.displayName ?: friend.domainId,
									freshness = freshness,
									collapsed = collapsed,
									onToggle = {
										val open = collapsedGateways.value
										collapsedGateways.value = if (collapsed) open - friendKey else open + friendKey
									},
								)
							}
							if (!collapsed) {
								if (friendSessions.isEmpty()) {
									item(key = "empty:$friendKey") {
										Text(
											"No shared sessions",
											style = MaterialTheme.typography.bodySmall,
											color = MaterialTheme.colorScheme.onSurfaceVariant,
											modifier = Modifier.padding(start = 20.dp, top = 4.dp, bottom = 8.dp),
										)
									}
								} else {
									items(
										friendSessions,
										key = { "friend-session:${friend.domainId}:${it.gatewayId}:${it.team}" },
									) { session ->
										LinkedFriendSessionRow(session)
									}
								}
							}
						}
					}
				}
			}
		}
}

/** The single status surface when the board has no sessions (HealthHeader is hidden in this state);
 * exactly one branch renders, keyed on connection state. A terminal cause is checked before the spinners. */
@Composable
private fun EmptyBoard(
	state: ChatState,
	onManage: () -> Unit,
	onAddGateway: () -> Unit,
	onHostHelp: () -> Unit,
	onRefresh: () -> Unit,
	onVerifyEnroll: (() -> Unit)? = null,
) {
	Column(
		Modifier.fillMaxSize().padding(32.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		when {
			// A friend who just first-rooted has no host of their own yet (the invite omits gateway
			// ids by design), and the admin's own fresh provision first-roots too - so both land
			// here. Add a Gateway goes straight to the scanner; the friend with no computer yet still has
			// the body's "set up a computer" guidance.
			state.noGatewayState == NoGatewayState.AWAITING_HOST -> {
				Text("You're all set up", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("Your Domain is ready. Set up a computer to run your agents, then add its Gateway here.")
				// An outstanding in-person trust compare (the admin who invited you is waiting) takes the
				// primary slot; adding a Gateway becomes the secondary step.
				if (onVerifyEnroll != null) {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onVerifyEnroll)) { Text("Verify with the admin") }
					Spacer(Modifier.height(4.dp))
					TextButton(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				} else {
					Spacer(Modifier.height(20.dp))
					Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				}
			}
			// No Gateway admitted yet: the primary onboarding step goes straight to the scanner, with the
			// setup manual as the secondary step.
			state.noGatewayState == NoGatewayState.NEEDS_GATEWAY -> {
				Text("No Gateways yet", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody("The computer that runs your agents.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onAddGateway)) { Text("Add a Gateway") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onHostHelp)) { Text("Running Gateway Setup") }
			}
			// A terminal failure that will not self-heal (secure storage, 401, admission rejected, or
			// an enrollment that gave up past the grace window). Name the actual cause from `error`
			// and offer a way forward - never "see the banner above", which is not on screen here.
			state.status == "error" -> {
				Text("Can't connect", style = MaterialTheme.typography.titleLarge)
				Spacer(Modifier.height(8.dp))
				BoardBody(state.error ?: "Couldn't reach your Gateway.")
				Spacer(Modifier.height(20.dp))
				Button(onClick = hapticClick(onRefresh)) { Text("Try again") }
				Spacer(Modifier.height(4.dp))
				TextButton(onClick = hapticClick(onManage)) { Text("Gateways") }
			}
			// Mid-enrollment, still self-healing: the poll loop keeps retrying and clears it on the
			// first success; past the grace window it escalates into the terminal branch above.
			state.enrollingSince != 0L -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Setting up...", style = MaterialTheme.typography.titleMedium)
				Spacer(Modifier.height(4.dp))
				BoardBody("Finishing enrollment with your Gateway.")
			}
			// Establishing the connection for the first time. A transient cause (no network, server
			// unreachable) is set on state.error by classifyConnError; surface it under the spinner so
			// a fresh friend with no network sees "Offline - no network", not a bare endless spinner.
			!state.connected -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Connecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
			}
			// Connected but the recent polls failed: online-ish, quietly reconnecting. Show the
			// classified cause when one is set, so a transient stall is named rather than silent.
			state.pollFailStreak > 0 -> {
				CircularProgressIndicator()
				Spacer(Modifier.height(12.dp))
				Text("Reconnecting...", color = MaterialTheme.colorScheme.onSurfaceVariant)
				state.error?.takeIf { it.isNotBlank() }?.let {
					Spacer(Modifier.height(8.dp))
					BoardBody(it)
				}
			}
			// Connected and healthy, just nothing here yet.
			else -> Text("No active sessions yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
	}
}

/** Centered, muted body copy shared by the empty-board states. */
@Composable
private fun BoardBody(text: String) {
	Text(
		text,
		style = MaterialTheme.typography.bodyMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		textAlign = TextAlign.Center,
	)
}

@Composable
fun HealthHeader(state: ChatState) {
	val (dot, label) = when {
		// Enrolled but no Gateway admitted yet is an ONBOARDING state, not a red error: the board
		// body owns the Add-a-Gateway CTA, so the header stays a calm positive status (no duplicate).
		state.needsGateway -> Color(0xFF0969DA) to "Enrolled"
		state.health == ChatState.Health.ONLINE -> STATUS_GREEN to "Bridge online"
		// Calm blue while a fresh enrollment's allowlist is still syncing to its Gateway -
		// a normal, self-healing window, not an error.
		state.health == ChatState.Health.SYNCING -> Color(0xFF0969DA) to (state.error ?: "Finishing enrollment...")
		// Show the SPECIFIC classified cause (set by classifyConnError) rather than a
		// blanket label, so the header tells the human exactly what to fix.
		state.health == ChatState.Health.DEGRADED -> STATUS_AMBER to (state.error ?: "Reconnecting...")
		else -> Color(0xFFCF222E) to (state.error ?: "Offline")
	}
	Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
			Spacer(Modifier.width(8.dp))
			Text(label, style = MaterialTheme.typography.labelLarge)
			Spacer(Modifier.width(6.dp))
			// This app's own version, right by the status, so the running build is visible at a glance.
			Text(
				"v${BuildConfig.VERSION_NAME}",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				fontFamily = FontFamily.Monospace,
			)
			Spacer(Modifier.weight(1f))
			if (state.deviceName.isNotEmpty()) {
				Text(
					state.deviceName,
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					fontFamily = FontFamily.Monospace,
				)
			}
		}
	}
}

////////////////////////////////
//  Functions & Helpers

/** The base board/thread word for a wire status, before any working/waking/login refinement. The
 * single owner of the status-word vocabulary; pair with presenceColor for the chip color. */
internal fun statusWord(status: String): String = when (status) {
	"online" -> "live"
	"verifying" -> "verifying"
	"available" -> "available"
	else -> "ended"
}

// Shared status-color tokens: presenceColor, HealthHeader, and crossDomainFreshnessColor all converge
// on live/caution semantics - named once so a future rebrand can't update one copy and miss another.
private val STATUS_GREEN = Color(0xFF2EA043)
private val STATUS_AMBER = Color(0xFFD29922)

////////////////////////////////
//  Composables

/** Chip color for the board/thread presence vocabulary. */
@Composable
internal fun presenceColor(presence: String): Color = when (presence) {
	"live" -> STATUS_GREEN
	"working...", "waking...", "verifying" -> STATUS_AMBER
	"available" -> Color(0xFF0969DA)
	"check terminal", "limit hit" -> Color(0xFFDA3633)
	else -> MaterialTheme.colorScheme.outline
}

@Composable
internal fun StatusChip(text: String, color: Color) {
	Surface(color = color.copy(alpha = 0.16f), shape = MaterialTheme.shapes.small) {
		Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
			Box(Modifier.size(7.dp).clip(CircleShape).background(color))
			Spacer(Modifier.width(5.dp))
			Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
		}
	}
}

/** A chevron-driven, collapsible section header with a trailing slot the caller owns entirely (a
 * Create button, online/offline label, freshness chip). Shared by GatewayHeader and LinkedFriendHeader. */
@Composable
private fun CollapsibleSectionHeader(
	name: String,
	collapsed: Boolean,
	onToggle: () -> Unit,
	trailing: @Composable () -> Unit,
) {
	Row(
		Modifier
			.fillMaxWidth()
			.clip(MaterialTheme.shapes.small)
			.hapticClickable(onClick = onToggle)
			.padding(horizontal = 4.dp, vertical = 8.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		// Down when open, right when collapsed: the chevron points at where the content is, or at
		// where it would appear. Auto-mirrored so it points left in an RTL layout.
		Icon(
			if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Default.ExpandMore,
			contentDescription = if (collapsed) "Expand" else "Collapse",
			tint = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		Spacer(Modifier.width(10.dp))
		Text(
			name,
			style = MaterialTheme.typography.titleMedium,
			fontFamily = FontFamily.Monospace,
			maxLines = 1,
			overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		trailing()
	}
}

@Composable
private fun GatewayHeader(
	name: String,
	online: Boolean,
	collapsed: Boolean,
	onToggle: () -> Unit,
	showCreate: Boolean = false,
	onCreate: (() -> Unit)? = null,
) {
	CollapsibleSectionHeader(name, collapsed, onToggle) {
		if (showCreate && onCreate != null) {
			// Your own Gateway only - a contained button (not a bare icon) reads as tappable on sight.
			// Its own click region wins over the row's collapse-toggle for taps landing inside it.
			Button(onClick = hapticClick(onCreate)) {
				Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
				Spacer(Modifier.width(6.dp))
				Text("Create")
			}
		} else {
			Text(
				if (online) "online" else "offline",
				style = MaterialTheme.typography.labelSmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

////////////////////////////////
//  Functions & Helpers

private fun crossDomainFreshnessColor(freshness: CrossDomainFreshness): Color =
	when (freshness) {
		CrossDomainFreshness.FRESH -> STATUS_GREEN
		CrossDomainFreshness.STALE -> STATUS_AMBER
		CrossDomainFreshness.UNKNOWN -> Color(0xFF8B949E) // neutral gray - not yet judgeable, not a warning
	}

private fun crossDomainFreshnessLabel(freshness: CrossDomainFreshness): String =
	when (freshness) {
		CrossDomainFreshness.FRESH -> "fresh"
		CrossDomainFreshness.STALE -> "stale"
		CrossDomainFreshness.UNKNOWN -> "unknown"
	}

////////////////////////////////
//  Composables

/** A linked friend Domain's collapsible header - the freshness-chip analog of GatewayHeader's binary
 * online/offline text, since a friend's currency is a 3-state judgment (fresh/stale/unknown), not up-or-down. */
@Composable
private fun LinkedFriendHeader(name: String, freshness: CrossDomainFreshness, collapsed: Boolean, onToggle: () -> Unit) {
	CollapsibleSectionHeader(name, collapsed, onToggle) {
		StatusChip(crossDomainFreshnessLabel(freshness), crossDomainFreshnessColor(freshness))
	}
}

/** One of a linked friend's shared sessions - display-only (no click-through; this board section
 * shows what a friend has shared, it does not open a chat with their session). */
@Composable
private fun LinkedFriendSessionRow(session: CrossDomainPresenceSession) {
	Row(
		Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Column(Modifier.weight(1f)) {
			Text(
				session.sessionLabel ?: session.team,
				style = MaterialTheme.typography.bodyMedium,
				maxLines = 1,
				overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			)
			session.description?.let {
				Text(
					it,
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
				)
			}
		}
		Text(
			statusWord(session.status),
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
}

/** A devcontainer project's spawn-point row: a purely informational display. Creating a session
 * happens via the Gateway row's Create button. The project itself is never a chat (clean break). */
@Composable
private fun SpawnPointHeader(project: String, online: Boolean) {
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(project, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace)
		Spacer(Modifier.weight(1f))
		Text(
			if (online) "awake" else "asleep",
			style = MaterialTheme.typography.labelSmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}
}

@Composable
fun SectionLabel(text: String) {
	Text(
		text.uppercase(),
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		letterSpacing = androidx.compose.ui.unit.TextUnit(1.5f, androidx.compose.ui.unit.TextUnitType.Sp),
		modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 2.dp),
	)
}

/** One shared 0f-1f sweep phase driving every SessionCard's working/verifying pulse bar, so a board
 * with several busy sessions runs one animation loop instead of one per card. */
@Composable
private fun rememberSessionsPulsePhase(): State<Float> {
	val transition = rememberInfiniteTransition(label = "sessionsPulse")
	return transition.animateFloat(
		initialValue = 0f,
		targetValue = 1f,
		animationSpec = infiniteRepeatable(animation = tween(1600, easing = LinearEasing)),
		label = "pulsePhase",
	)
}

/** Slim animated accent bar for a "verifying" or "working" session. Reads `phase` inside `drawBehind`'s
 * draw-phase callback rather than the composable body, so it repaints just this bar, not the whole card. */
@Composable
private fun PulseBar(phase: State<Float>, modifier: Modifier = Modifier) {
	val amber = presenceColor("working...")
	Box(
		modifier
			.fillMaxWidth()
			.height(3.dp)
			.clip(MaterialTheme.shapes.extraSmall)
			.background(amber.copy(alpha = 0.18f))
			.drawBehind {
				val highlightWidth = size.width * 0.4f
				val x = -highlightWidth + phase.value * (size.width + highlightWidth * 2f)
				drawRect(
					brush = Brush.horizontalGradient(
						colors = listOf(Color.Transparent, amber, Color.Transparent),
						startX = x,
						endX = x + highlightWidth,
					),
				)
			},
	)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionCard(
	state: ChatState,
	team: Team,
	nested: Boolean = false,
	pulsePhase: State<Float>,
	// The board's live line, when this session has unfinished board work. sessionCardPreview decides
	// what it does to the ladder; null means this session has no board work to show.
	boardLine: BoardLiveLine? = null,
	// The branch that line sits in. Null falls back to drawing the line alone.
	boardBranch: com.atelier_nyaarium.switchboard.board.CardBranch? = null,
	onClick: () -> Unit,
	onLongPress: () -> Unit,
) {
	val haptics = LocalHapticFeedback.current
	val strong = rememberStrongHaptic()
	val display = state.label(team.name)
	val unread = state.unread[team.name] ?: 0
	val live = team.status == "online"
	val statusWord = statusWord(team.status)
	// The board tile reads the presence plane directly (Team.working/needsLogin, daemon-derived and
	// pushed on the poll response) rather than this device's own peek - a board session has no peek
	// stream of its own. Null means unknown (never observed, or
	// derivation just became impossible), never false - a tile shows no pulse rather than a stale
	// frozen one, so both chips are gated on an explicit `== true`, not a null-as-false fallback.
	val checkTerminal = live && team.needsLogin == true
	val limitHit = live && team.limitBlocked == true
	// "working" and "verifying" are one busy state sharing a single pulse bar. A limit-blocked session
	// is stopped rather than busy, so it must not pulse even if the frame that derived it caught a
	// spinner still on screen.
	val busy = statusWord == "verifying" || (live && team.working == true && !limitHit)
	// Ambient presence: full color while connected or busy, muted once asleep or gone ("down or
	// asleep" both read the same muted way - only a connected/busy session keeps full-color text).
	val titleColor =
		if (statusWord == "available" || statusWord == "ended") {
			MaterialTheme.colorScheme.onSurfaceVariant
		} else {
			MaterialTheme.colorScheme.onSurface
		}
	// Presence is colour/motion only on the title, so a screen reader needs it spelled out here.
	val presenceDescription =
		if (limitHit) "session limit hit"
		else if (checkTerminal) "check terminal"
		else if (busy) "working"
		else statusWord
	// The clip keeps the ripple inside the card's rounded corners. A nested session card indents
	// under its spawn-point header.
	Card(
		modifier = Modifier.fillMaxWidth().padding(start = if (nested) 16.dp else 0.dp).clip(CardDefaults.shape).combinedClickable(
			onClick = {
				haptics.performHapticFeedback(HapticFeedbackType.LongPress)
				onClick()
			},
			onLongClick = {
				strong()
				onLongPress()
			},
		),
	) {
		Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
				Text(
					display,
					style = MaterialTheme.typography.titleMedium,
					fontFamily = FontFamily.Monospace,
					color = titleColor,
					maxLines = 1,
					overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f).clearAndSetSemantics { contentDescription = "$display, $presenceDescription" },
				)
				if (limitHit) StatusChip("limit hit", presenceColor("limit hit"))
				if (checkTerminal) StatusChip("check terminal", presenceColor("check terminal"))
				// Visible from the board without opening the thread. The dock inside the thread is
				// still the sole edit/cancel surface, this is read-only.
				if (state.scheduledSends.containsKey(team.name)) {
					Icon(
						Icons.Default.Schedule,
						contentDescription = "Scheduled send pending",
						tint = MaterialTheme.colorScheme.onSurfaceVariant,
						modifier = Modifier.size(16.dp),
					)
				}
				// Plugin-version chip: shown only when the agent's running plugin differs from
				// this app's expected version (BuildConfig.VERSION_NAME, derived from the same
				// package.json the build reads). Not a warning - the host auto-updates daily, so
				// a lag is benign and self-correcting. Neutral color, version only, no label.
				team.version?.let { v ->
					if (v != BuildConfig.VERSION_NAME) StatusChip("v$v", MaterialTheme.colorScheme.outline)
				}
				if (unread > 0) Badge { Text("$unread") }
			}
			if (busy) PulseBar(pulsePhase)
			// The ladder, top down: the session's own last reply headline, then its unfinished board
			// work, then the thread's newest row. sessionCardPreview owns which of those show and what
			// each is stamped with; this only paints what it answered.
			val preview = sessionCardPreview(state, team.name, boardLine, boardBranch)
			preview.headline?.let { headline ->
				Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
					Text(
						headline,
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
						modifier = Modifier.weight(1f),
					)
					preview.headlineAt?.let {
						Text(
							relativeTime(it),
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
			val liveBoardWork = preview.boardWork
			if (liveBoardWork != null) {
				// The branch when there is one, else the single line it replaces. The count rides the FIRST
				// row either way, and counts the whole session rather than the shown branch, so it does not
				// change meaning with which branch happens to be current.
				val branch = preview.boardBranch
				if (branch == null) {
					BoardCardRow(liveBoardWork.state, liveBoardWork.title, depth = 0) {
						BoardCardCount(liveBoardWork)
					}
				} else {
					branch.rows.forEachIndexed { index, row ->
						BoardCardRow(row.entry.state, oneLine(row.entry.title).orEmpty(), row.depth) {
							if (index == 0) BoardCardCount(liveBoardWork)
						}
					}
					if (branch.hidden > 0) {
						Text(
							"+${branch.hidden} more",
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							modifier = Modifier.padding(start = 19.dp),
						)
					}
				}
			}
			val snippet = preview.snippet
			val timeShown = preview.snippetAt
			if (snippet != null || timeShown != null) {
				Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
					if (snippet != null) {
						Text(
							snippet,
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							maxLines = 1,
							overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
							modifier = Modifier.weight(1f),
						)
					} else {
						Spacer(Modifier.weight(1f))
					}
					timeShown?.let {
						Text(
							relativeTime(it),
							style = MaterialTheme.typography.labelSmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
		}
	}
}

/** One board row on a session card. Indented a little tighter than the thread strip's, since a card
 * has a narrower column and the depth only has to be readable, not measured. */
@Composable
private fun BoardCardRow(state: String, title: String, depth: Int, trailing: @Composable () -> Unit) {
	Row(
		Modifier.fillMaxWidth().padding(start = (depth * 13).dp),
		horizontalArrangement = Arrangement.spacedBy(7.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		com.atelier_nyaarium.switchboard.board.StateMark(state)
		Text(
			title,
			style = MaterialTheme.typography.bodySmall,
			textDecoration = if (state == "cancelled") TextDecoration.LineThrough else null,
			maxLines = 1,
			overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
			modifier = Modifier.weight(1f),
		)
		trailing()
	}
}

@Composable
private fun BoardCardCount(line: com.atelier_nyaarium.switchboard.board.BoardLiveLine) {
	Text(
		"${line.finished}/${line.total}",
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}

@Composable
fun SessionActionsDialog(
	label: String,
	canRename: Boolean,
	onRename: () -> Unit,
	onForget: () -> Unit,
	onDismiss: () -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(label, fontFamily = FontFamily.Monospace) },
		text = {
			Column {
				if (canRename) {
					TextButton(onClick = hapticClick(onRename), modifier = Modifier.fillMaxWidth()) { Text("Rename") }
				} else {
					Text(
						"Project names come from the Gateway and cannot be renamed.",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				TextButton(onClick = hapticClick(onForget), modifier = Modifier.fillMaxWidth()) { Text("Forget...") }
			}
		},
		confirmButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

@Composable
fun ConfirmDialog(title: String, body: String, confirmText: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = { Text(body) },
		confirmButton = { TextButton(onClick = hapticClick(onConfirm)) { Text(confirmText) } },
		dismissButton = { TextButton(onClick = hapticClick(onDismiss)) { Text("Cancel") } },
	)
}

/** Forgetting a session with unfinished board work: cancel the tasks (trash with the session) or
 * unassign them (return to the backlog). Dismissing abandons the forget rather than deciding by inaction. */
@Composable
internal fun BoardForgetDialog(
	label: String,
	undone: Int,
	onCancelTasks: () -> Unit,
	onUnassign: () -> Unit,
	onDismiss: () -> Unit,
) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("Forget $label?") },
		text = {
			Text(
				"It still holds $undone unfinished task${if (undone == 1) "" else "s"}. " +
					"Finished ones go to the trash either way.",
			)
		},
		confirmButton = { TextButton(onClick = hapticClick(onUnassign)) { Text("Back to the backlog") } },
		dismissButton = { TextButton(onClick = hapticClick(onCancelTasks)) { Text("Mark cancelled") } },
	)
}
