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
internal class PresenceOps(private val host: PresenceHost) : ClearsOnReprovision {
	// Serialize projection check and apply.
	private val projectionMutex = Mutex()
	private var lastProjectionAt = 0L

	// Raw snapshot for tombstone-expiry recovery.
	@Volatile var lastRawTeams: List<Team>? = null

	// Last reported anchor per team.
	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	/** Reapply cached teams each tick. */
	override suspend fun clearInMemory() {
		lastRawTeams = null
		lastProjectionAt = 0L
		lastReportedReadAnchors = emptyMap()
	}

	/** Refresh the cached local display name. */
	fun refreshDisplayNameFromTeams() {
		val gw = host.homeGatewayId
		val local = host.state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != host.storedDisplayName) host.storedDisplayName = local
		if (local != host.state.value.displayName) host.state.update { it.copy(displayName = local) }
	}

	/** Apply linked peers and prune removed Domains. */
	suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
		// One owner per Domain.
		val owners = peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
		host.state.update {
			it.copy(
				linkedPeerOwners = owners,
				// Roster removal prunes cached peers.
				crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domainId -> domainId in owners },
			)
		}
	}

	/** Upsert changed cross-Domain presence. */
	suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		host.state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	/** Apply read anchors by row position. Epochs are random tags, compared only for equality. */
	fun applyReadAnchors(entries: List<com.atelier_nyaarium.switchboard.proto.ReadAnchorWireEntry>) {
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

	/** Report local anchor advances without failing the poll. */
	suspend fun reportLocalReadAdvances() {
		val anchors = host.state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { host.reportRead(team, anchor.epoch, anchor.seq) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	/** Reset cursors and refresh immediately. */
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

	/** Land the last Router projection at startup, so the roster shows before the Router's version
	 * moves. Only while nothing has landed: a live projection always outranks the held one. */
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

	/** Apply the Router's owner projection. */
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
			// Storage faults do not block presence.
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
		// The picker offers what the Router last projected; a Gateway that stops advertising drops off.
		if (projection.spawnPoints != host.state.value.gatewaySpawnPoints) {
			host.state.update { it.copy(gatewaySpawnPoints = projection.spawnPoints) }
		}
	}

	private suspend fun applyPlanePresenceLocked(planeRows: List<Team>, coveredGateways: Set<String>) {
		val local = host.homeGatewayId
		// Only pushed rows become LIVE.
		val fresh = planeRows.map { it.withAuthority(Authority.LIVE) }
		val planeDomain = fresh.firstOrNull()?.domainId
		val merged = mergePresence(lastRawTeams ?: emptyList(), fresh) { row ->
			keepPriorRow(row, local, planeDomain, coveredGateways)
		}
		applyPresenceLocked(merged)
	}

	/** Refresh connected Gateways, preserving failures. */
	suspend fun refreshConnectedGateways() {
		val ids = runCatchingCancellable { host.fetchConnectedGateways() }.getOrNull() ?: return
		if (ids != host.state.value.connectedGateways) host.state.update { it.copy(connectedGateways = ids) }
	}

	/** Cache raw presence before tombstone filtering. */
	private suspend fun applyPresenceLocked(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	private val freshTeamsMutex = Mutex()

	/** Prefer live evidence over receipts. */
	private fun foldReceipt(row: Team): Team {
		if (row.presence.isLive) {
			host.clearReceipt(row.name)
			return row.withReceipt(null)
		}
		return row.withReceipt(host.receiptFor(row.name, System.currentTimeMillis()))
	}

	// Debounce action-triggered pulls.
	private var lastActionPullAt = 0L
	private val ACTION_PULL_DEBOUNCE_MS = 2_000L

	suspend fun refreshAfterAction() {
		val now = System.currentTimeMillis()
		if (now - lastActionPullAt < ACTION_PULL_DEBOUNCE_MS) return
		lastActionPullAt = now
		refreshPresencePlane()
	}

	/** Reapply cached teams under the rebuild mutex. */
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
