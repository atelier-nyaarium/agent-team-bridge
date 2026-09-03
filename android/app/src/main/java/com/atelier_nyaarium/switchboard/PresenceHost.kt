package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow

internal interface PresenceHost {
	val state: MutableStateFlow<ChatState>
	val homeGatewayId: String
	var storedDisplayName: String
	val forgottenUntil: MutableMap<String, Long>

	suspend fun <T> withDrainMutex(block: suspend () -> T): T
	suspend fun resetPlaneCursors()
	suspend fun reportRead(team: String, epoch: Long, seq: Long)
	suspend fun fetchPresencePlanes(): com.atelier_nyaarium.switchboard.proto.PlanesReadResult?
	fun fetchConnectedGateways(): List<String>?

	fun loadRouterState(kind: String): RouterStateSlot?
	fun saveRouterState(kind: String, slot: RouterStateSlot)
	fun persistLabels(labels: Map<String, String>)
	fun persistAbsenceStreaks(streaks: Map<String, Int>)
	fun persistReadAnchors(anchors: Map<String, ReadAnchor>)
	fun receiptFor(team: String, now: Long): ActionReceipt?
	fun clearReceipt(team: String)
}

internal class ChatRepositoryPresenceHost(private val repo: ChatRepository) : PresenceHost {
	override val state get() = repo._state
	override val homeGatewayId get() = repo.homeGatewayId
	override var storedDisplayName
		get() = repo.store.displayName
		set(value) { repo.store.displayName = value }
	override val forgottenUntil get() = repo.forgottenUntil

	override suspend fun <T> withDrainMutex(block: suspend () -> T): T = repo.drain.withDrainMutex(block)
	override suspend fun resetPlaneCursors() = repo.drain.resetPlaneCursors()
	override suspend fun reportRead(team: String, epoch: Long, seq: Long) {
		repo.client().reportRead(team, epoch, seq)
	}
	override suspend fun fetchPresencePlanes() = repo.client().planesRead(kotlinx.serialization.json.buildJsonObject {})
	override fun fetchConnectedGateways(): List<String>? = repo.client().fetchConnectedGateways()
	override fun loadRouterState(kind: String) = repo.store.loadRouterState(kind)
	override fun saveRouterState(kind: String, slot: RouterStateSlot) = repo.store.saveRouterState(kind, slot)
	override fun persistLabels(labels: Map<String, String>) = repo.persistence.persistLabels(labels)
	override fun persistAbsenceStreaks(streaks: Map<String, Int>) = repo.persistence.persistAbsenceStreaks(streaks)
	override fun persistReadAnchors(anchors: Map<String, ReadAnchor>) = repo.persistence.persistReadAnchors(anchors)
	override fun receiptFor(team: String, now: Long) = repo.sessions.receiptFor(team, now)
	override fun clearReceipt(team: String) = repo.sessions.clearReceipt(team)
}
