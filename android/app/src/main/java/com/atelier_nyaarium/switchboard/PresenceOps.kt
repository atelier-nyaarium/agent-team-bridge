package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.CrossDomainPresenceEntry
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The team roster and the plane snapshots that keep it true: presence, linked peers, cross-Domain
 * presence, and the cross-device read anchors reported back. Owns the raw-snapshot cache, the
 * last-reported anchors and the rebuild mutex, which is why it is a held delegate rather than
 * extensions the way the voice settings and the drafts are. */
internal class PresenceOps(private val repo: ChatRepository) : ClearsOnReprovision {
	// The raw (pre-tombstone, pre-label-override) team snapshot the presence merge path last saw -
	// never persisted (a fresh process starts with no cache and full-resyncs on its first poll).
	// Re-merging this same cached list against the CURRENT tombstone set is what lets a
	// tombstone's own expiry resurrect a team locally without waiting for a fresh server push -
	// see applyPresence.
	// Not private: connect() (ChatRepositoryDomainLink.kt) seeds it from its own initial teams pull.
	@Volatile var lastRawTeams: List<Team>? = null

	// The per-team read anchor last REPORTED to the Gateway (via report_read), so the poll loop
	// reports a team's local anchor only once per genuine local advance instead of every cycle.
	// Never persisted: a fresh process starts empty, so its first cycle re-reports every team's
	// current anchor - a harmless no-op on the Gateway if nothing actually changed (monotonic merge).
	// Not private: SessionOps.forget drops a forgotten team's entry.
	@Volatile var lastReportedReadAnchors: Map<String, ReadAnchor> = emptyMap()

	/** reapplyCachedTeams runs every tick, so until a fresh poll lands the cached snapshot would
	 * merge the previous owner's roster back in. */
	override suspend fun clearInMemory() {
		lastRawTeams = null
		lastReportedReadAnchors = emptyMap()
	}

	/** Refresh the cached display name from discovery's LOCAL session (the gateway stamps each
	 * session's displayName; the local Gateway's is this owner's own). A no-op when no local session
	 * carries one yet, so a board with only peer sessions never blanks the cached name. */
	// Not private: connect() (ChatRepositoryDomainLink.kt) refreshes from its own initial teams pull.
	fun refreshDisplayNameFromTeams() {
		val gw = repo.localGatewayId
		val local = repo._state.value.teams.firstOrNull {
			(it.gatewayId.ifEmpty { gw }) == gw && !it.displayName.isNullOrEmpty()
		}?.displayName ?: return
		if (local != repo.store.displayName) repo.store.displayName = local
		if (local != repo._state.value.displayName) repo._state.update { it.copy(displayName = local) }
	}

	/** Apply the linked-peers plane's pushed snapshot into state, so TrustOps.linkedDomains() can union it
	 * with discovery. The one writer of linkedPeerOwners - the poll loop calls this when a poll
	 * response carries `linkedPeers` (a real change; see PlaneRegistry). Folds the per-gateway peer
	 * rows to their distinct Domain ids (a Domain may run more than one gateway). */
	suspend fun applyLinkedPeers(peers: List<com.atelier_nyaarium.switchboard.proto.CrossDomainPeerEntry>) {
		// domainId -> friend owner key (a Domain may run several gateways under one owner; last wins).
		val owners = peers.filter { it.domainId.isNotEmpty() }.associate { it.domainId to it.ownerSignPub }
		repo._state.update {
			it.copy(
				linkedPeerOwners = owners,
				// crossDomainPeerSessions is a per-domainId UPSERT (applyCrossDomainPresence), which has
				// no other way to notice an unlinked/untrusted friend's cached entry should disappear -
				// this roster change is the authoritative signal to prune it.
				crossDomainPeerSessions = it.crossDomainPeerSessions.filterKeys { domainId -> domainId in owners },
			)
		}
		repo.drain.pruneCrossDomainVersions(owners.keys)
	}

	/** Apply the cross-Domain-presence plane's pushed/pulled entries into state: a per-domainId
	 * UPSERT (never a wholesale replace - see crossDomainPeerSessions' own doc), since the wire only
	 * carries the SUBSET of linked Domains whose plane actually changed this poll. The one writer of
	 * crossDomainPeerSessions - the poll loop calls this when a poll response carries
	 * `crossDomainPresence`. */
	suspend fun applyCrossDomainPresence(entries: List<CrossDomainPresenceEntry>) {
		repo.drain.upsertCrossDomainVersions(entries)
		repo._state.update { it.copy(crossDomainPeerSessions = it.crossDomainPeerSessions + entries.associateBy { e -> e.domainId }) }
	}

	/** Apply the read-anchors plane's pushed snapshot: another of this owner's OWN devices may have
	 * read further than this one has locally recorded. Monotonic, mirroring the Gateway's own merge
	 * (readAnchors.ts) but resolved by ROW POSITION rather than numeric epoch/seq (this device's
	 * thread is its own local render order - see isAnchorAdvance's own doc on why equality/position,
	 * not numeric comparison, is the sound check here). A synced entry whose row this device has not
	 * drained yet simply does not resolve (isAnchorAdvance returns false) and is silently skipped -
	 * low-stakes by design (see readAnchors.ts): it self-heals the moment this device's OWN reading
	 * catches up and reports past it, so there is nothing to retry or queue here. Called AFTER this
	 * poll's own fresh entries are folded into `_state.threads` (the poll loop's burst-append loop),
	 * so a row that arrived in the SAME response as its own read-anchor bump already resolves. Marks
	 * every applied entry as already-reported too, so the very next cycle's outbound report pass does
	 * not immediately bounce a just-adopted synced value straight back to the Gateway. */
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

	/** Report every team whose local read anchor has advanced past what this device last told the
	 * Gateway (see lastReportedReadAnchors). Fire-and-forget per team: a failure here must never
	 * surface as a poll failure (it would wrongly trip the offline/reconnect UI for what is, per
	 * readAnchors.ts, low-stakes data that self-heals on the next successful report), so each report
	 * is individually caught and logged. Marks a team reported regardless of the Gateway's own
	 * `advanced` verdict - even a false (another device already reported further) means THIS device
	 * has successfully told the Gateway its own position, so re-sending it every cycle would be
	 * pure waste. */
	suspend fun reportLocalReadAdvances() {
		val anchors = repo._state.value.readAnchors
		for (team in teamsNeedingReadReport(anchors, lastReportedReadAnchors)) {
			val anchor = anchors.getValue(team)
			runCatching { repo.client().reportRead(team, anchor.epoch, anchor.seq) }
				.onSuccess { lastReportedReadAnchors = lastReportedReadAnchors + (team to anchor) }
				.onFailure { DebugLog.log("Plane", "report_read failed for $team: ${it.message?.take(120)}") }
		}
	}

	/** Pull-to-refresh: forget the known presence AND linked-peers
	 * versions so the NEXT poll looks like a cold boot (ships everything for both planes), and
	 * interrupt any currently-held poll so that next poll fires now instead of inheriting up to
	 * LONG_POLL_HOLD_MS of staleness waiting out the remainder of an already-open hold - a bare
	 * version clear underneath a still-running held poll would otherwise wait for that poll's own
	 * natural expiry before the cleared version even reaches the server. Also pulls mesh-wide
	 * discovery immediately (see refreshDiscovery) rather than waiting out its own bounded
	 * interval, so a manual refresh covers everything a user would expect it to. */
	suspend fun refreshTeams() = withContext(Dispatchers.IO) {
		repo.drain.resetPlaneCursors()
		repo.drain.interrupt()
		refreshDiscovery()
	}

	/** Mesh-wide discovery: this Gateway's own live relay to every other same-Domain gateway and
	 * linked cross-Domain peer (routes.discover(), via the list_teams op). Unlike presence and
	 * linked-peers, this has no push mechanism yet, so it needs an explicit pull, on the poll
	 * loop's own bounded interval (DISCOVERY_REFRESH_MS) or immediately after an action that
	 * changes what should be discoverable (a manual refresh, an unlink). Routes through the same
	 * merge path as everything else (applyPresence), so tombstones/label-overrides/absence-streaks
	 * apply uniformly regardless of source. Best-effort: a relay failure keeps the prior list. */
	suspend fun refreshDiscovery() {
		runCatchingCancellable { repo.client().teams(repo.localGatewayId) }
			.onSuccess { applyDiscovery(it) }
	}

	/**
	 * Render the last projection the Router sent, so a cold start shows the roster it had rather than
	 * an empty list until the socket connects. Absent before the first push, which is a fresh install.
	 */
	suspend fun restoreLastProjection() {
		val slot = runCatching { repo.store.loadRouterState("presence") }.getOrNull() ?: return
		val projection = runCatching {
			wireJson.decodeFromJsonElement(OwnerPresenceProjection.serializer(), slot.payload)
		}.getOrNull() ?: return
		applyOwnerProjection(projection)
	}

	/**
	 * Land the Router's pushed owner projection.
	 *
	 * It carries what discovery used to be pulled for, so it goes through the same merge path: the
	 * unreachable holds, the tombstones and the absence streaks all apply regardless of source.
	 */
	suspend fun applyOwnerProjection(projection: OwnerPresenceProjection) {
		// Kept as a versioned envelope of what the Router last said, so a cold start renders the last
		// roster instead of an empty list while the socket is still connecting. An older version is
		// ignored, which is what stops a slow answer overwriting a newer one.
		// Version gates roster and persistence. Stale projections regress the live roster.
		// Storage faults do not block presence. Only confirmed staleness blocks apply.
		val stale = runCatching {
			val slot = RouterStateSlot(
				epoch = projection.plane.epoch,
				version = projection.plane.version,
				payload = wireJson.encodeToJsonElement(OwnerPresenceProjection.serializer(), projection),
			)
			if (!newerRouterState(slot, repo.store.loadRouterState("presence"))) return@runCatching true
			repo.store.saveRouterState("presence", slot)
			false
		}.getOrDefault(false)
		if (stale) return
		applyDiscovery(
			TeamsAnswer(
				projection.rows.map { teamInfoToTeam(it, repo.localGatewayId) },
				projection.coverage,
				projection.spawnPoints,
			),
		)
		applyCrossDomainPresence(projection.linked)
	}

	/** Land a discovery answer, holding rows for gateways the answer names as unreachable: those
	 * machines were not asked, so their sessions must not be swept as absent. An answer with no
	 * coverage (an older gateway) replaces wholesale, the pre-coverage behavior. */
	suspend fun applyDiscovery(answer: TeamsAnswer) {
		val keys = unreachableKeys(answer.coverage)
		// Merged per Gateway rather than replaced wholesale, and only for the Gateways this answer
		// actually spoke for. A null list is an older gateway saying nothing, which must not read as
		// "no machine offers anything" and wipe what a previous answer established.
		//
		// A row for a gateway the answer names UNREACHABLE is DROPPED rather than held, which is the
		// opposite of what happens to that gateway's session rows just below, and deliberately so. A
		// held session row is worth keeping because it says what that machine WAS and the UI stamps it
		// unreachable. A spawn point is not a status; it is an offer to launch something, and offering
		// Windows on a machine that could not be reached this cycle is an invitation to a wake that
		// cannot succeed. Absent means unknown here, and unknown correctly shows only `host`.
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
			// A held row from an unreachable gateway is re-stamped UNREACHABLE rather than kept at
			// whatever it last claimed. That is the whole point of holding it: it says what that
			// machine WAS, and nothing that costs a round trip to it should be attempted on that
			// basis - which is what bounds a wake tap on a powered-off machine to zero peeks instead
			// of one every couple of seconds.
			mergePresence(lastRawTeams ?: emptyList(), answer.teams) { rowOnUnreachable(it, keys, repo.localGatewayId) }
				.map { if (rowOnUnreachable(it, keys, repo.localGatewayId)) it.withAuthority(Authority.UNREACHABLE) else it }
		}
		applyPresence(fresh)
	}

	/** Land a presence-plane push. The plane carries the ROUTE Gateway's own rows only, so it speaks
	 * for that gateway and no other: replacing wholesale swept every remote machine's rows on each
	 * local presence change, until the next discovery tick restored them. */
	suspend fun applyPlanePresence(planeRows: List<Team>) {
		val local = repo.localGatewayId
		// The ONE place a row is called LIVE. These arrived on the push from the Gateway that owns
		// them, so they are current as of this poll; every other row in the merged list keeps the
		// POLLED that teamInfoToTeam stamped, because discovery cannot say more than that.
		val fresh = planeRows.map { it.withAuthority(Authority.LIVE) }
		val planeDomain = fresh.firstOrNull()?.domainId
		val merged = mergePresence(lastRawTeams ?: emptyList(), fresh) { row ->
			val gw = row.gatewayId.ifEmpty { local }
			gw != local || (row.domainId != null && planeDomain != null && row.domainId != planeDomain)
		}
		applyPresence(merged)
	}

	/** Which of this owner's Gateways the Router currently holds a connection for. Best-effort, and a
	 * failure LEAVES the prior answer rather than clearing it: a momentary hiccup reporting every
	 * machine offline is worse than a slightly stale roster, since offline is the state that makes the
	 * board stop offering things. */
	suspend fun refreshConnectedGateways() {
		val ids = runCatchingCancellable { repo.client().fetchConnectedGateways() }.getOrNull() ?: return
		if (ids != repo._state.value.connectedGateways) repo._state.update { it.copy(connectedGateways = ids) }
	}

	/** The one plane-merge path: every fresh presence-plane snapshot lands in state through here
	 * and only here. Caches the raw list (lastRawTeams) so a LATER tombstone EXPIRY can re-derive
	 * `teams` from it directly (see reapplyCachedTeams) without waiting for a fresh server push -
	 * a failed or remote forget then resurrects locally on its own tombstone's schedule, not the
	 * next unrelated bump. */
	suspend fun applyPresence(fresh: List<Team>) {
		lastRawTeams = fresh
		reapplyCachedTeams()
	}

	private val freshTeamsMutex = Mutex()

	/**
	 * Attach this device's own outstanding request to a row, and retire it the moment the row itself
	 * proves the point.
	 *
	 * Evidence beats a request, always. A receipt only ever answers the question "is something coming
	 * that no Gateway has reported yet", so a row that already says the session is up retires it
	 * rather than being overridden by it. An optimistic value that can outrank a real report is a UI
	 * that lies, which is worse than one that is late.
	 */
	private fun foldReceipt(row: Team): Team {
		if (row.presence.isLive) {
			repo.sessions.clearReceipt(row.name)
			return row.withReceipt(null)
		}
		return row.withReceipt(repo.sessions.receiptFor(row.name, System.currentTimeMillis()))
	}

	// Coalesces the discovery pulls that follow an action. Several taps, or a wake landing beside the
	// loop's own tick, must not each fan `list_teams` out across every machine.
	private var lastActionPullAt = 0L
	private val ACTION_PULL_DEBOUNCE_MS = 2_000L

	/** Pull discovery right after an action whose effect this device cannot otherwise see for up to a
	 * discovery interval: the action was sealed to the session's OWN Gateway, and only the route
	 * Gateway's rows arrive by push. Debounced, and best-effort like every other discovery pull. */
	suspend fun refreshAfterAction() {
		val now = System.currentTimeMillis()
		if (now - lastActionPullAt < ACTION_PULL_DEBOUNCE_MS) return
		lastActionPullAt = now
		refreshDiscovery()
	}

	/** Re-derives `teams` from the cached raw snapshot (see applyPresence) against the CURRENT
	 * tombstone set: filterTombstoned's own sweep (forgottenUntil.entries.removeIf) means a
	 * tombstone that has since expired no longer masks its team, so calling this on every poll
	 * loop tick - fresh presence or not - is what makes a tombstone's expiry self-heal instead of
	 * waiting for the next unrelated bump. Folds in ChatState.withFreshTeams' label-override
	 * pruning + absence-streak rules. A no-op before anything has ever been cached. Serialized
	 * against a concurrent call (the poll loop's own tick and a manual refreshTeams() both run on
	 * Dispatchers.IO) so two overlapping snapshots cannot each persist their own labels/streaks
	 * with no ordering guarantee between them - SharedPreferences.apply() only guarantees the
	 * LAST-CALLED write for a key eventually wins, not that "last called" lines up with "computed
	 * from the newer fetch" once two independent capture-then-persist sequences interleave. */
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
