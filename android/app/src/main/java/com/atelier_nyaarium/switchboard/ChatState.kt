package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.parseTarget

////////////////////////////////
//  Interfaces & Types

data class ChatState(
	val provisioned: Boolean = false,
	val teams: List<Team> = emptyList(),
	/** Spawn points each Gateway advertises; held across presence pushes. */
	val gatewaySpawnPoints: List<GatewaySpawnPoints> = emptyList(),
	/** Per Gateway, the project last spawned there. Only a SUGGESTION for the create dialog, which
	 * re-checks it against what that Gateway offers now, so a stale entry preselects nothing. */
	val lastProjectByGateway: Map<String, String> = emptyMap(),
	val threads: Map<String, List<Message>> = emptyMap(),
	val unread: Map<String, Int> = emptyMap(),
	/** Per-team read anchor, the single source of truth `unread` is derived from. */
	val readAnchors: Map<String, ReadAnchor> = emptyMap(),
	val openTabs: List<String> = emptyList(),
	/** Teams explicitly closed via Close Tab, cleared when that tab reopens. Downgrades notifications
	 * to a quiet unread bump. A never-opened team is not in this set, so a brand-new session still
	 * notifies normally: only a deliberate close should quieten a team. */
	val closedTeams: Set<String> = emptySet(),
	/** Per-session working truth from a tmux peek, which outranks the message-status heuristic. */
	val sessionWorking: Map<String, Boolean> = emptyMap(),
	/** Per-session logged-out truth from a tmux peek. Tracked apart from working, since a logged-out
	 * session still renders a composer. */
	val sessionNeedsLogin: Map<String, Boolean> = emptyMap(),
	val status: String = "",
	/** Per-team composer content, and the single owner of it: a cancelled failed send, a cancelled
	 * scheduled send and the live picker all read and write through this one map, so none can clobber
	 * what the others hold. Sparse; see [withDraft]. */
	val drafts: Map<String, Draft> = emptyMap(),
	val error: String? = null,
	val gap: Boolean = false,
	val biometricLock: Boolean = false,
	val deviceName: String = "",
	val labels: Map<String, String> = emptyMap(),
	/** Consecutive fresh-teams observations a locally-labeled team has been missing from entirely, as
	 * opposed to present with no server label. Feeds [withFreshTeams]'s prune rule. */
	val teamAbsenceStreaks: Map<String, Int> = emptyMap(),
	val connected: Boolean = false,
	/** Mirrors ChatRepository.isVisible, but Compose-reactive, so a composable collects it here
	 * instead of opening its own LocalLifecycleOwner subscription. */
	val foreground: Boolean = false,
	val pollFailStreak: Int = 0,
	/** Connected Gateway id, learned from the register result. Empty before the first
	 * federation-aware connect, where bare names resolve to the local Gateway. */
	val homeGatewayId: String = "",
	/** Epoch ms while a post-enrollment allowlist sync is in progress: the device is admitted but the
	 * home Gateway has not re-synced, so sealed ops transiently reject. Drives the calm SYNCING
	 * header; cleared once an op succeeds or the grace lapses. */
	val enrollingSince: Long = 0L,
	/** Every Gateway this owner has admitted, by gateway id. The sessions board unions these with the
	 * Gateways its session rows name, so a machine with no sessions yet is still drawn and still
	 * offers Create - which is the whole reason a second machine was invisible.
	 *
	 * The keyring rather than a roster fetch: it is exactly the set this device can SEAL to, so a drawn
	 * section is always an actionable one and the two cannot drift. Republished on each keyring fold
	 * rather than read per recomposition, since resolving a member verifies its admission. */
	val admittedGateways: List<String> = emptyList(),
	/** Which of those Gateways the Router currently holds a connection for, or NULL when it has not
	 * said. Null is not "none": nothing is reported offline except on an answer that arrived, so a
	 * Router that is older or momentarily unreachable makes the board say less rather than lie.
	 *
	 * Separate from [admittedGateways] because they answer different questions and perish at different
	 * rates. Admission is durable and says a machine is yours; this is perishable and says it is
	 * switched on. Folding them lost exactly the distinction between a machine sitting idle and one
	 * nobody could reach. */
	val connectedGateways: List<String>? = null,
	/** Linked friend Domains by owner key. */
	val linkedPeerOwners: Map<String, String> = emptyMap(),
	/** A linked friend Domain's sessions, keyed by domainId and UPSERTED per domain. The wire ships
	 * only the subset whose plane changed, so a wholesale replace would wipe every other friend's
	 * cached entry. Pruned to the current [linkedPeerOwners] keys whenever that roster changes, since
	 * an upsert has no other way to notice an unlinked friend should disappear. */
	val crossDomainPeerSessions: Map<String, CrossDomainPresenceEntry> = emptyMap(),
	val displayName: String = "",
	/** True once this device has first-rooted a pending friend Domain from its invite blob. Lets the
	 * empty board tell a friend with no host yet from an admin who has admitted no Gateway. */
	val firstRooted: Boolean = false,
	/** A one-shot Snackbar message. Separate from `error`, which drives the STICKY health header, so a
	 * one-off cannot bleed into an unrelated later render. Consumed via consumeTransientMessage(). */
	val transientMessages: List<String> = emptyList(),
	/** At most one pending scheduled send per team. Held here rather than in a bare repository map so
	 * the dock indicator and the session-tile clock icon are Compose-reactive. */
	val scheduledSends: Map<String, ScheduledSend> = emptyMap(),
	/** At most one armed goal per team, held here for the same reason as [scheduledSends]. */
	val goals: Map<String, PendingGoal> = emptyMap(),
	/** (project, label) pairs with a spawnSession() call in flight. Distinct from the longer-lived
	 * opId retry window: this is only "has not settled yet", so the dialog can refuse a second
	 * identical submission rather than silently reattaching to the first. */
	val pendingSpawns: Set<Pair<String, String>> = emptySet(),
	/** Teams whose cold wake is being waited on (raise time), shown as a notice card rather than a
	 * transcript row: a wake is this device's own local state, not something anybody said. Not
	 * persisted, since nothing is coming to clear it after a process death. Time-valued because the
	 * clearing event is an ANSWER, and a woken session that never answers would otherwise hold
	 * "waking..." for the process's life - reads treat an entry past [WAKE_NOTICE_TTL_MS] as absent. */
	val wakingTeams: Map<String, Long> = emptyMap(),
) {
	/** Whether a send is genuinely still waiting on this team's cold boot. The expiry lives in the
	 * READ, so a stale entry cannot freeze the chip however the writers evolve. */
	fun awaitingWake(team: String, now: Long = System.currentTimeMillis()): Boolean {
		val raisedAt = wakingTeams[team] ?: return false
		return now - raisedAt < WAKE_NOTICE_TTL_MS
	}

	/** Live teams plus any team we already have a thread with. A thread-only peer is gone from the
	 * bridge and cannot be woken, so it is synthesized as an ended loose session with no mode. Team
	 * names and thread keys are both the canonical address string, so the plain membership test below
	 * cannot mint a phantom "ended" entry for a bare versus qualified form of the same team. */
	fun sessions(): List<Team> {
		val known = teams.mapTo(HashSet()) { it.name }
		return teams + threads.keys.filter { it !in known }.map { Team(it, Presence.ended()) }
	}

	/**
	 * Replace the live teams from a fresh fetch, folding in the two rules that keep a local label
	 * override from outliving its reason to exist.
	 *
	 * The moment the server reports its own sessionLabel, the local override is dropped whatever that
	 * value is, self-healing a stale edit. A locally-labeled team missing ENTIRELY accumulates a
	 * streak instead, and is only dropped past [ABSENCE_PRUNE_STREAK]: one miss must never wipe a
	 * legitimate pending edit, and reappearing resets it.
	 */
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

	/**
	 * Whether the agent is working a turn.
	 *
	 * The presence plane FIRST, the same source the session tiles read: it keeps arriving at whatever
	 * cadence this device's focus asks for, while a local peek only lands while the terminal is open.
	 * Reading the peek first froze the thread's chip at whatever it saw the last time that terminal
	 * was on screen. Then a pending cold wake, then the message-status heuristic.
	 */
	fun working(team: String): Boolean {
		teams.firstOrNull { it.name == team }?.presence?.working?.let { return it }
		sessionWorking[team]?.let { return it }
		if (awaitingWake(team)) return true
		val last = threads[team]?.lastOrNull() ?: return false
		return (last.fromMe && (last.status == null || last.status == "pending")) || last.status == "running"
	}

	/** Independent of working: a logged-out session still presents a composer. Same order as
	 * [working], and for the same reason. */
	fun needsLogin(team: String): Boolean =
		teams.firstOrNull { it.name == team }?.presence?.needsLogin ?: (sessionNeedsLogin[team] == true)

	/** Bridge link health for the dashboard header. */
	enum class Health { ONLINE, SYNCING, DEGRADED, OFFLINE }

	val health: Health
		get() = when {
			connected && pollFailStreak == 0 -> Health.ONLINE
			enrollingSince != 0L && !connected -> Health.SYNCING
			pollFailStreak >= 2 -> Health.OFFLINE
			connected -> Health.DEGRADED
			else -> Health.OFFLINE
		}

	/** Terminal "no Gateway admitted yet", so the board shows onboarding rather than a connection
	 * error. Keyed off the message [classifyConnError] emits, so keep that prefix in sync. */
	val needsGateway: Boolean
		get() = error?.startsWith("Add a Gateway") == true

	/** Which no-gateway guidance applies: a friend's bring-up-a-host state, or an admin's onboarding. */
	val noGatewayState: NoGatewayState
		get() = FriendOnboarding.noGatewayState(needsGateway, firstRooted)

	fun lastActivity(team: String): Long? = threads[team]?.maxByOrNull { it.at }?.at

	/** The thread's newest row, whatever its origin. */
	fun lastRow(team: String): Message? = threads[team]?.lastOrNull()

	/**
	 * One-line preview from the thread tail, preferring a notice's title over its long body.
	 *
	 * Takes the last row of ANY origin, unlike [lastReply], because it answers "what happened here
	 * last": the owner's own send and an agent-to-agent mirror both belong. Only the headline rung
	 * claims to be the session's word to the owner, and only it filters.
	 */
	fun snippet(team: String): String? = lastRow(team)?.let { oneLine(it.title) ?: oneLine(it.text) }

	/**
	 * The session's LATEST word to the owner: its most recent reply, whatever that was.
	 *
	 * Scanning back past a newer reply to find an older TITLED one would headline something the
	 * session has already moved on from, so a reply with no title yields null and lets the snippet
	 * rung show instead.
	 */
	fun lastReply(team: String): Message? = threads[team]?.lastOrNull { !it.fromMe && !it.isPeer }

	/** A local rename wins, then the gateway's sessionLabel. Null when neither exists. The single
	 * owner of label precedence. */
	fun labelOrNull(team: String): String? = labels[team] ?: teams.firstOrNull { it.name == team }?.sessionLabel

	/** The friendly name for a team, falling back to the session leaf. The board nests under a
	 * spawn-point header, so the leaf alone identifies the session; the raw key is never shown. */
	fun label(team: String): String = labelOrNull(team) ?: sessionLeaf(team)

	/** The chat team an entry's stored `sessionId` names, on a given Gateway. Board entries key by the
	 * bare local field, unique only within one Gateway, so both halves are needed or two machines
	 * running the same project.session resolve to each other's label. */
	fun teamForSessionKey(gatewayId: String, key: String): String? =
		teams.firstOrNull { it.gatewayId == gatewayId && localFieldOrSelf(it.name) == key }?.name
			?: teams.firstOrNull { it.gatewayId.isEmpty() && localFieldOrSelf(it.name) == key }?.name
}

////////////////////////////////
//  Functions & Helpers

/** Consecutive misses before [ChatState.withFreshTeams] prunes a local label override. More than one
 * so a single transient gap in a fetch cannot wipe a legitimate pending edit. */
private const val ABSENCE_PRUNE_STREAK = 2

// Matches the gateway's own wake budget: past this, a wake that produced no answer is not coming.
private const val WAKE_NOTICE_TTL_MS = 10 * 60_000L

/** Recompute `team`'s unread from `thread` and this state's own anchor for it. The single derivation
 * every writer converges on, so `unread` can never drift from `threads`/`readAnchors`. */
internal fun ChatState.recomputeUnread(team: String, thread: List<Message>): ChatState =
	copy(unread = unread + (team to unreadCount(thread, readAnchors[team])))

/** The session segment of a canonical address, the natural per-session label. A spawn-point yields
 * its spawn segment; an unparseable value degrades to "?" rather than echoing the raw string, so a
 * corrupted key can never surface a full internal address where a placeholder belongs. */
internal fun sessionLeaf(canonical: String): String =
	runCatching {
		when (val t = parseTarget(canonical, "", "")) {
			is Address -> t.session
			else -> canonical.substringAfterLast('.')
		}
	}.getOrDefault("?")
