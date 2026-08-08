package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardLiveLine
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceSession
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import kotlinx.coroutines.delay

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

/** The session-board grouping key: the full (Domain, Gateway) pair. A gateway id is
 * unique only within a Domain, so two linked friend Domains running an identically-named
 * gateway must group separately rather than merge. */
internal data class GatewayGroupKey(val domainId: String, val gatewayId: String)

////////////////////////////////
//  Composables

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
