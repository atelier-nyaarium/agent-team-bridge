package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.parseTarget


data class ChatState(
	val provisioned: Boolean = false,
	val teams: List<Team> = emptyList(),
	/** Spawn points persist across presence pushes. */
	val gatewaySpawnPoints: List<GatewaySpawnPoints> = emptyList(),
	/** Used only as a stale-safe create-dialog suggestion. */
	val lastProjectByGateway: Map<String, String> = emptyMap(),
	val threads: Map<String, List<Message>> = emptyMap(),
	val unread: Map<String, Int> = emptyMap(),
	/** Unread counts derive from these anchors. */
	val readAnchors: Map<String, ReadAnchor> = emptyMap(),
	val openTabs: List<String> = emptyList(),
	/** Only deliberate closes quiet unread notifications. */
	val closedTeams: Set<String> = emptySet(),
	/** Terminal peek truth outranks message-status heuristics. */
	val sessionWorking: Map<String, Boolean> = emptyMap(),
	/** Login state remains separate from working state. */
	val sessionNeedsLogin: Map<String, Boolean> = emptyMap(),
	val status: String = "",
	val drafts: Map<String, Draft> = emptyMap(),
	val error: String? = null,
	val gap: Boolean = false,
	val biometricLock: Boolean = false,
	val deviceName: String = "",
	val labels: Map<String, String> = emptyMap(),
	/** Pruning requires consecutive absence observations. */
	val teamAbsenceStreaks: Map<String, Int> = emptyMap(),
	val connected: Boolean = false,
	/** Mirrors repository visibility for Compose observation. */
	val foreground: Boolean = false,
	val pollFailStreak: Int = 0,
	val homeGatewayId: String = "",
	val domainId: String? = null,
	/** Nonzero while enrollment admits the device before sync completes. */
	val enrollingSince: Long = 0L,
	/** Keyring membership is the actionable Gateway set. */
	val admittedGateways: List<String> = emptyList(),
	/** Null means connectivity has not been reported. */
	val connectedGateways: List<String>? = null,
	val linkedPeerOwners: Map<String, String> = emptyMap(),
	val crossDomainPeerSessions: Map<String, CrossDomainPresenceEntry> = emptyMap(),
	val displayName: String = "",
	/** Distinguishes a rooted friend from an unadmitted administrator. */
	val firstRooted: Boolean = false,
	/** Snackbar messages do not drive sticky health state. */
	val transientMessages: List<String> = emptyList(),
	/** At most one scheduled send belongs to each team. */
	val scheduledSends: Map<String, ScheduledSend> = emptyMap(),
	/** At most one armed goal belongs to each team. */
	val goals: Map<String, PendingGoal> = emptyMap(),
	/** Prevents duplicate identical spawn submissions while unsettled. */
	val pendingSpawns: Set<Pair<String, String>> = emptySet(),
	/** Wake notices expire on read and are not persisted. */
	val wakingTeams: Map<String, Long> = emptyMap(),
) {
	/** Expiry belongs to the read, so stale wakes cannot persist. */
	fun awaitingWake(team: String, now: Long = System.currentTimeMillis()): Boolean {
		val raisedAt = wakingTeams[team] ?: return false
		return now - raisedAt < WAKE_NOTICE_TTL_MS
	}

	fun sessions(): List<Team> {
		val known = teams.mapTo(HashSet()) { it.name }
		return teams + threads.keys.filter { it !in known }.map { Team(it, Presence.ended()) }
	}

	/** Server labels clear local overrides; absence requires a streak. */
	fun withFreshTeams(freshTeams: List<Team>): ChatState {
		val fresh = freshTeams.associateBy { it.name }
		val nextLabels = mutableMapOf<String, String>()
		val nextStreak = mutableMapOf<String, Int>()
		for ((team, label) in labels) {
			val server = fresh[team]
			when {
				server?.sessionLabel != null -> {}
				server != null -> nextLabels[team] = label
				else -> {
					val streak = (teamAbsenceStreaks[team] ?: 0) + 1
					if (streak < ABSENCE_PRUNE_STREAK) {
						nextLabels[team] = label
						nextStreak[team] = streak
					}
				}
			}
		}
		return copy(teams = freshTeams, labels = nextLabels, teamAbsenceStreaks = nextStreak)
	}

	/** Presence outranks peek, then wake state, then message status. */
	fun working(team: String): Boolean {
		teams.firstOrNull { it.name == team }?.presence?.working?.let { return it }
		sessionWorking[team]?.let { return it }
		if (awaitingWake(team)) return true
		val last = threads[team]?.lastOrNull() ?: return false
		return (last.fromMe && (last.status == null || last.status == "pending")) || last.status == "running"
	}

	fun needsLogin(team: String): Boolean =
		teams.firstOrNull { it.name == team }?.presence?.needsLogin ?: (sessionNeedsLogin[team] == true)

	enum class Health { ONLINE, SYNCING, DEGRADED, OFFLINE }

	val health: Health
		get() = when {
			connected && pollFailStreak == 0 -> Health.ONLINE
			enrollingSince != 0L && !connected -> Health.SYNCING
			pollFailStreak >= 2 -> Health.OFFLINE
			connected -> Health.DEGRADED
			else -> Health.OFFLINE
		}

	val needsGateway: Boolean
		get() = error?.startsWith("Add a Gateway") == true

	val noGatewayState: NoGatewayState
		get() = FriendOnboarding.noGatewayState(needsGateway, firstRooted)

	fun lastActivity(team: String): Long? = threads[team]?.maxByOrNull { it.at }?.at

	fun lastRow(team: String): Message? = threads[team]?.lastOrNull()

	/** Snippets use the latest row; replies use the latest owner-directed row. */
	fun snippet(team: String): String? = lastRow(team)?.let { oneLine(it.title) ?: oneLine(it.text) }

	/** A titleless latest reply yields to the thread snippet. */
	fun lastReply(team: String): Message? = threads[team]?.lastOrNull { !it.fromMe && !it.isPeer }

	fun labelOrNull(team: String): String? = labels[team] ?: teams.firstOrNull { it.name == team }?.sessionLabel

	fun label(team: String): String = labelOrNull(team) ?: sessionLeaf(team)

	fun teamForSessionKey(gatewayId: String, key: String): String? =
		teams.firstOrNull { it.gatewayId == gatewayId && localFieldOrSelf(it.name) == key }?.name
			?: teams.firstOrNull { it.gatewayId.isEmpty() && localFieldOrSelf(it.name) == key }?.name
}


private const val ABSENCE_PRUNE_STREAK = 2

private const val WAKE_NOTICE_TTL_MS = 10 * 60_000L

internal fun ChatState.recomputeUnread(team: String, thread: List<Message>): ChatState =
	copy(unread = unread + (team to unreadCount(thread, readAnchors[team])))

internal fun sessionLeaf(canonical: String): String =
	runCatching {
		when (val t = parseTarget(canonical, "", "")) {
			is Address -> t.session
			else -> canonical.substringAfterLast('.')
		}
	}.getOrDefault("?")
