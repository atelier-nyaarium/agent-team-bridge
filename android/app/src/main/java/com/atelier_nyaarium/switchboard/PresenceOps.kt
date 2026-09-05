package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class PresenceOps(private val host: PresenceHost) : ClearsOnReprovision {
	private val projectionMutex = Mutex()
	private var lastProjectionAt = 0L

	// Raw rows remain available for tombstone expiry recovery.
	@Volatile var lastRawTeams: List<Team>? = null

	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	override suspend fun clearInMemory() {
		lastRawTeams = null
		lastProjectionAt = 0L
		lastReportedReadAnchors = emptyMap()
	}

	fun refreshDisplayNameFromTeams() {
		val gw = host.homeGatewayId
		val local = host.state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != host.storedDisplayName) host.storedDisplayName = local
		if (local != host.state.value.displayName) host.state.update { it.copy(displayName = local) }
	}

	suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
		val owners = peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
		host.state.update {
			it.copy(
				linkedPeerOwners = owners,
				crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domainId -> domainId in owners },
			)
		}
	}

	suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		host.state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
		// Epochs are random tags; compare them only for equality.
		var anyChanged = false
		val next = host.state.updateAndGet { s ->
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
		if (anyChanged) host.persistReadAnchors(next.readAnchors)
	}

	suspend fun reportLocalReadAdvances() {
		val anchors = host.state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { host.reportRead(team, anchor) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		host.resetPlaneCursors()
		refreshPresencePlane()
	}

	private suspend fun refreshPresencePlane() {
		runCatchingCancellable { host.fetchPresencePlanes() }
			.onSuccess { result ->
				val payload = result?.planes?.firstOrNull { it.name == "presence" }?.payload ?: return@onSuccess
				val projection = wireJson.decodeFromJsonElement(
					com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection.serializer(),
					payload,
				)
				applyOwnerProjection(projection)
			}
	}

	suspend fun restoreLastProjection() {
		val slot = runCatching { host.loadRouterState("presence") }.getOrNull() ?: return
		val projection = runCatching {
			wireJson.decodeFromJsonElement(OwnerPresenceProjection.serializer(), slot.payload)
		}.getOrNull() ?: return
		host.withDrainMutex {
			projectionMutex.withLock {
				if (lastRawTeams != null) return@withLock
				landProjection(projection, bypassFreshness = true)
			}
		}
	}

	suspend fun applyOwnerProjection(projection: OwnerPresenceProjection) = host.withDrainMutex { projectionMutex.withLock {
		// Version check, save, and apply share one lock.
		val stale = runCatching {
			val slot = RouterStateSlot(
				epoch = projection.plane.epoch,
				version = projection.plane.version,
				payload = wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), projection),
			)
			if (!newerRouterState(slot, host.loadRouterState("presence"))) return@runCatching true
			host.saveRouterState("presence", slot)
			false
		}.getOrDefault(false)
		if (!stale) {
			lastProjectionAt = System.currentTimeMillis()
			landProjection(projection)
		}
	} }

	private suspend fun landProjection(projection: OwnerPresenceProjection, bypassFreshness: Boolean = false) {
		if (!bypassFreshness && System.currentTimeMillis() < lastProjectionAt) return
		applyPlanePresenceLocked(
			projection.rows.map { teamInfoToTeam(it, host.homeGatewayId) },
			projection.roster.mapTo(HashSet()) { it.gatewayId },
		)
		applyCrossDomainPresence(projection.linked)
		if (projection.spawnPoints != host.state.value.gatewaySpawnPoints) {
			host.state.update { it.copy(gatewaySpawnPoints = projection.spawnPoints) }
		}
	}

	private suspend fun applyPlanePresenceLocked(planeRows: List<Team>, coveredGateways: Set<String>) {
		// Only pushed rows become live.
		val local = host.homeGatewayId
		val fresh = planeRows.map { it.withAuthority(Authority.LIVE) }
		val planeDomain = fresh.firstOrNull()?.domainId
		val merged = mergePresence(lastRawTeams ?: emptyList(), fresh) { row ->
			keepPriorRow(row, local, planeDomain, coveredGateways)
		}
		applyPresenceLocked(merged)
	}

	suspend fun refreshConnectedGateways() {
		val ids = runCatchingCancellable { host.fetchConnectedGateways() }.getOrNull() ?: return
		if (ids != host.state.value.connectedGateways) host.state.update { it.copy(connectedGateways = ids) }
	}

	private suspend fun applyPresenceLocked(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	private val freshTeamsMutex = Mutex()

	private fun foldReceipt(row: Team): Team {
		if (row.presence.isLive) {
			host.clearReceipt(row.name)
			return row.withReceipt(null)
		}
		return row.withReceipt(host.receiptFor(row.name, System.currentTimeMillis()))
	}

	private var lastActionPullAt = 0L
	private val ACTION_PULL_DEBOUNCE_MS = 2_000L

	suspend fun refreshAfterAction() {
		val now = System.currentTimeMillis()
		if (now - lastActionPullAt < ACTION_PULL_DEBOUNCE_MS) return
		lastActionPullAt = now
		refreshPresencePlane()
	}

	suspend fun reapplyCachedTeams() {
		val raw = lastRawTeams ?: return
		freshTeamsMutex.withLock {
			val now = System.currentTimeMillis()
			val visible = filterTombstoned(raw, host.forgottenUntil, now).map(::foldReceipt)
			val next = host.state.updateAndGet { it.withFreshTeams(visible) }
			host.persistLabels(next.labels)
			host.persistAbsenceStreaks(next.teamAbsenceStreaks)
		}
		refreshDisplayNameFromTeams()
	}
}
