package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Presence planes and roster state. */
internal class PresenceOps(private val repo: ChatRepository) : ClearsOnReprovision {
	// Serialize projection check and apply.
	private val projectionMutex = Mutex()

	// Raw snapshot for tombstone-expiry recovery.
	@Volatile var lastRawTeams: List<Team>? = null

	// Last reported anchor per team.
	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	/** Reapply cached teams each tick. */
	override suspend fun clearInMemory() {
		lastRawTeams = null
		lastReportedReadAnchors = emptyMap()
	}

	/** Refresh the cached local display name. */
	fun refreshDisplayNameFromTeams() {
		val gw = repo.localGatewayId
		val local = repo._state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != repo.store.displayName) repo.store.displayName = local
		if (local != repo._state.value.displayName) repo._state.update { it.copy(displayName = local) }
	}

	/** Apply linked peers and prune removed Domains. */
	suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
		// One owner per Domain.
		val owners = peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
		repo._state.update {
			it.copy(
				linkedPeerOwners = owners,
				// Roster removal prunes cached peers.
				crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domainId -> domainId in owners },
			)
		}
		repo.drain.pruneCrossDomainVersions(owners.keys)
	}

	/** Upsert changed cross-Domain presence. */
	suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		repo.drain.upsertCrossDomainVersions(entries)
		repo._state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	/** Apply read anchors by row position. Epochs are random tags, compared only for equality. */
	fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
		var anyChanged = false
		val next = repo._state.updateAndGet { s ->
			var st = s
			for (e in entries) {
				val team = e.team
				val thread = st.threads[team].orEmpty()
				val candidate = ReadAnchor(e.epoch, e.seq, e.at)
				if (isAnchorAdvance(thread, st.readAnchors[team], candidate)) {
					anyChanged = true
					lastReportedReadAnchors = lastReportedReadAnchors + (team to candidate)
					st = st.copy(readAnchors = st.readAnchors + (team to candidate)).recomputeUnread(team, thread)
				}
			}
			st
		}
		if (anyChanged) repo.persistence.persistReadAnchors(next.readAnchors)
	}

	/** Report local anchor advances without failing the poll. */
	suspend fun reportLocalReadAdvances() {
		val anchors = repo._state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { repo.client().reportRead(team, anchor.epoch, anchor.seq) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	/** Reset cursors and refresh immediately. */
	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		repo.drain.resetPlaneCursors()
		repo.drain.interrupt()
		refreshDiscovery()
	}

	/** Best-effort mesh-wide discovery pull. */
	suspend fun refreshDiscovery() {
		runCatchingCancellable { repo.client().teams(repo.localGatewayId) }
			.onSuccess { applyDiscovery(it) }
	}

	/** Restore the last Router projection. */
	suspend fun restoreLastProjection() {
		val slot = runCatching { repo.store.loadRouterState("presence") }.getOrNull() ?: return
		val projection = runCatching {
			wireJson.decodeFromJsonElement(OwnerPresenceProjection.serializer(), slot.payload)
		}.getOrNull() ?: return
		// Restore without freshness gating.
		projectionMutex.withLock { landProjection(projection) }
	}

	/** Apply the Router's owner projection. */
	suspend fun applyOwnerProjection(projection: OwnerPresenceProjection) = projectionMutex.withLock {
		// Version check, save, and apply share one lock.
		val stale = runCatching {
			val slot = RouterStateSlot(
				epoch = projection.plane.epoch,
				version = projection.plane.version,
				payload = wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), projection),
			)
			if (!newerRouterState(slot, repo.store.loadRouterState("presence"))) return@runCatching true
			repo.store.saveRouterState("presence", slot)
			false
			// Storage faults do not block presence.
		}.getOrDefault(false)
		if (!stale) landProjection(projection)
	}

	private suspend fun landProjection(projection: OwnerPresenceProjection) {
		applyDiscovery(
			TeamsAnswer(
				projection.rows.map { teamInfoToTeam(it, repo.localGatewayId) },
				projection.coverage,
				projection.spawnPoints,
			),
		)
		applyCrossDomainPresence(projection.linked)
	}

	/** Apply discovery, preserving unreachable rows. */
	suspend fun applyDiscovery(answer: TeamsAnswer) {
		val keys = unreachableKeys(answer.coverage)
		// Merge only gateways covered by this answer.
		answer.spawnPoints?.let { fresh ->
			val spoke = fresh.map { it.gatewayId }.toSet()
			repo._state.update { s ->
				val kept = s.gatewaySpawnPoints.filterNot { it.gatewayId in spoke || it.gatewayId in keys }
				s.copy(gatewaySpawnPoints = kept + fresh)
			}
		}
		val fresh = if (keys.isEmpty()) {
			answer.teams
		} else {
			// Held rows remain unreachable.
			mergePresence(lastRawTeams ?: emptyList(), answer.teams) { rowOnUnreachable(it, keys, repo.localGatewayId) }
				.map { if (rowOnUnreachable(it, keys, repo.localGatewayId)) it.withAuthority(Authority.UNREACHABLE) else it }
		}
		applyPresence(fresh)
	}

	/** Apply route-Gateway presence rows. */
	suspend fun applyPlanePresence(planeRows: List<Team>) {
		val local = repo.localGatewayId
		// Only pushed rows become LIVE.
		val fresh = planeRows.map { it.withAuthority(Authority.LIVE) }
		val planeDomain = fresh.firstOrNull()?.domainId
		val merged = mergePresence(lastRawTeams ?: emptyList(), fresh) { row ->
			val gw = row.gatewayId.ifEmpty { local }
			gw != local || (row.domainId != null && planeDomain != null && row.domainId != planeDomain)
		}
		applyPresence(merged)
	}

	/** Refresh connected Gateways, preserving failures. */
	suspend fun refreshConnectedGateways() {
		val ids = runCatchingCancellable { repo.client().fetchConnectedGateways() }.getOrNull() ?: return
		if (ids != repo._state.value.connectedGateways) repo._state.update { it.copy(connectedGateways = ids) }
	}

	/** Cache raw presence before tombstone filtering. */
	suspend fun applyPresence(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	private val freshTeamsMutex = Mutex()

	/** Prefer live evidence over receipts. */
	private fun foldReceipt(row: Team): Team {
		if (row.presence.isLive) {
			repo.sessions.clearReceipt(row.name)
			return row.withReceipt(null)
		}
		return row.withReceipt(repo.sessions.receiptFor(row.name, System.currentTimeMillis()))
	}

	// Debounce action-triggered pulls.
	private var lastActionPullAt = 0L
	private val ACTION_PULL_DEBOUNCE_MS = 2_000L

	/** Debounced post-action discovery. */
	suspend fun refreshAfterAction() {
		val now = System.currentTimeMillis()
		if (now - lastActionPullAt < ACTION_PULL_DEBOUNCE_MS) return
		lastActionPullAt = now
		refreshDiscovery()
	}

	/** Reapply cached teams under the rebuild mutex. */
	suspend fun reapplyCachedTeams() {
		val raw = lastRawTeams ?: return
		freshTeamsMutex.withLock {
			val now = System.currentTimeMillis()
			val visible = filterTombstoned(raw, repo.forgottenUntil, now).map(::foldReceipt)
			val next = repo._state.updateAndGet { it.withFreshTeams(visible) }
			repo.persistence.persistLabels(next.labels)
			repo.persistence.persistAbsenceStreaks(next.teamAbsenceStreaks)
		}
		refreshDisplayNameFromTeams()
	}
}
