package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import kotlinx.coroutines.delay


internal fun sessionOrder(state: ChatState): Comparator<Team> =
	compareByDescending<Team> { it.isLive }
		.thenByDescending { state.lastActivity(it.name) ?: 0L }
		.thenBy { state.label(it.name) }

// Peer rows render in the linked-friends section.
internal fun localSessions(sessions: List<Team>, adminDomainId: String): List<Team> =
	sessions.filter { it.domainId.isNullOrEmpty() || it.domainId == adminDomainId }

// Peer presence is untrusted and may duplicate keys.
internal fun dedupedFriendSessions(sessions: List<CrossDomainPresenceSession>): List<CrossDomainPresenceSession> =
	sessions.distinctBy { it.gatewayId to it.team }

// Gateway IDs are unique only within a Domain.
internal data class GatewayGroupKey(val domainId: String, val gatewayId: String)

internal fun groupByGateway(
	local: List<Team>,
	admittedGateways: List<String>,
	adminDomainId: String,
	homeGatewayId: String,
): List<Pair<GatewayGroupKey, List<Team>>> {
	// Admit headless Gateways so idle machines remain actionable.
	val grouped = local.groupBy {
		GatewayGroupKey(it.domainId.orEmpty().ifEmpty { adminDomainId }, it.gatewayId.ifEmpty { homeGatewayId })
	}
	val admitted =
		admittedGateways.filter { it.isNotEmpty() && (adminDomainId.isNotEmpty() || it == homeGatewayId) }
	val empties =
		admitted
			.map { GatewayGroupKey(adminDomainId, it) }
			.filterNot { it in grouped }
			.associateWith { emptyList<Team>() }
	return (grouped + empties).toList().sortedBy { (key, _) ->
		if (key.domainId == adminDomainId && key.gatewayId == homeGatewayId) "" else "${key.domainId}/${key.gatewayId}"
	}
}

internal val HOST_SPAWN_IDS = setOf("host", "windows")

internal fun initialProject(remembered: String?, projects: List<String>): String? =
	remembered?.takeIf { it in projects }

internal fun hostSpawnLabel(id: String, offered: List<String>): String = when {
	id == "windows" -> "Windows"
	id == "host" && offered.contains("windows") -> "WSL"
	else -> id
}

internal fun hostSpawnChoices(
	advertised: List<GatewaySpawnPoints>,
	key: GatewayGroupKey,
	adminDomainId: String,
): List<String> {
	val offered = advertised.filter { it.groupKey(adminDomainId) == key }.flatMap { it.hostSpawns }
	val detected = offered.filter { it in HOST_SPAWN_IDS && it != "host" }.distinct().sorted()
	return detected + "host"
}

internal data class CreateDialogTarget(
	val domainId: String,
	val gatewayId: String,
	val isLocal: Boolean,
	val projects: List<String>,
) {
	fun targetFor(project: String): String =
		if (isLocal || domainId.isEmpty() || gatewayId.isEmpty()) {
			project
		} else {
			runCatching { SpawnPoint.of(domainId, gatewayId, project).canonical }.getOrDefault(project)
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
	onListDirs: suspend (String, String, String) -> DirListing = { _, _, _ -> DirListing(emptyList()) },
	onVerifyEnroll: (() -> Unit)? = null,
	onRouterEndpoint: (() -> Unit)? = null,
	boardLine: (Team) -> BoardLiveLine? = { null },
	boardBranch: (Team) -> com.atelier_nyaarium.switchboard.board.CardBranch? = { null },
	undoneFor: (Team) -> Int = { 0 },
	onForgetWithTasks: (String, Boolean) -> Unit = { _, _ -> },
	modifier: Modifier = Modifier,
) {
	var actionTeam by remember { mutableStateOf<Team?>(null) }
	var createDialogFor by remember { mutableStateOf<CreateDialogTarget?>(null) }
	var renameTeam by remember { mutableStateOf<Team?>(null) }
	var forgetTeam by remember { mutableStateOf<Team?>(null) }
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
	createDialogFor?.let { opened ->
		CreateSessionDialog(
			gateway = opened.gatewayId,
			projects = opened.projects,
			pendingSpawns = state.pendingSpawns,
			targetOf = opened::targetFor,
				onListDirs = { path, spawn -> onListDirs(path, opened.targetFor(spawn), spawn) },
			rememberedProject = state.lastProjectByGateway[opened.gatewayId],
			onSpawn = { target, session, workdir ->
				onSpawn(target, session, workdir)
				createDialogFor = null
			},
			onDismiss = { createDialogFor = null },
		)
	}

	Column(modifier.fillMaxSize()) {
		val sessions = state.sessions()
			val adminDomainId = state.domainId.orEmpty()
			val local = localSessions(sessions, adminDomainId)
			// Linked peers remain visible before local Domain discovery.
			val linkedDomains = CrossDomainLink.mergeLinkedDomains(state.teams, state.linkedPeerOwners, adminDomainId)
			val byGateway = groupByGateway(local, state.admittedGateways, adminDomainId, state.homeGatewayId)
			val onboarding = (byGateway.isEmpty() && linkedDomains.isEmpty()) ||
				(local.isEmpty() && linkedDomains.isEmpty() && emptyBoardHasCause(state))
			if (!onboarding) HealthHeader(state)
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
			if (onboarding) {
				EmptyBoard(
					state,
					onManage,
					onAddGateway,
					onHostHelp,
					onRefresh,
					onVerifyEnroll = onVerifyEnroll,
					onRouterEndpoint = onRouterEndpoint,
				)
			} else {
				val pulsePhase = rememberSessionsPulsePhase()
				val order = sessionOrder(state)
				var freshnessNow by remember { mutableStateOf(System.currentTimeMillis()) }
				LaunchedEffect(linkedDomains.isNotEmpty(), state.foreground) {
					if (linkedDomains.isEmpty() || !state.foreground) return@LaunchedEffect
					while (true) {
						// Refresh immediately when foreground monitoring starts.
						freshnessNow = System.currentTimeMillis()
						delay(30_000)
					}
				}
				LazyColumn(
					Modifier.fillMaxSize(),
					contentPadding = PaddingValues(12.dp),
					verticalArrangement = Arrangement.spacedBy(8.dp),
				) {
					for ((key, group) in byGateway) {
						val composite = "${key.domainId}/${key.gatewayId}"
						val collapsed = composite in collapsedGateways.value
						val isPeer = key.domainId.isNotEmpty() && adminDomainId.isNotEmpty() && key.domainId != adminDomainId
						val headerName = if (isPeer) composite else key.gatewayId
						// Peer Gateways cannot be local spawn targets.
						val showCreate =
							!isPeer && (key.gatewayId == state.homeGatewayId || key.gatewayId in state.admittedGateways)
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
									createDialogFor = CreateDialogTarget(
										domainId = key.domainId,
										gatewayId = key.gatewayId,
										isLocal = key.gatewayId == state.homeGatewayId,
										projects = hostSpawnChoices(state.gatewaySpawnPoints, key, adminDomainId) +
											spawnPoints.map { localName(it) }.filterNot { it in HOST_SPAWN_IDS },
									)
								},
								reachable = if (isPeer) null else state.connectedGateways?.contains(key.gatewayId),
							)
						}
						if (!collapsed) {
							val composites = group.filter { it.kind != "devcontainer" && isComposite(localName(it)) }
							val flatLoose =
								group.filter { it.kind != "devcontainer" && !isComposite(localName(it)) }.sortedWith(order)
							val byProject = composites.groupBy { parseSessionName(localName(it)).project }
							val spawnKeys = spawnPoints.map { localName(it) }.toSet()

							fun renderProject(projectKey: String, header: @Composable () -> Unit) {
								val sessions = byProject[projectKey].orEmpty().sortedWith(order)
								if (sessions.isEmpty()) return
								// Spawn names are unique only within a Gateway.
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

							if (showCreate) {
								renderProject("host") {
									SpawnPointHeader(project = "host", online = byProject["host"].orEmpty().any { it.isLive })
								}
							}
							for (sp in spawnPoints) {
								val proj = localName(sp)
								if (showCreate && proj == "host") continue
								renderProject(proj) {
									SpawnPointHeader(
										project = proj,
										online = byProject[proj].orEmpty().any { it.isLive },
									)
								}
							}
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
