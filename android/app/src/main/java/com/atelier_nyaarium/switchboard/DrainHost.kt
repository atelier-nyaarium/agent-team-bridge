package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.PlaneRead
import com.atelier_nyaarium.switchboard.proto.SyncAdvance
import com.atelier_nyaarium.switchboard.proto.SyncCursor
import com.atelier_nyaarium.switchboard.proto.SyncPollResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** What the drain reaches on the repository. */
internal interface DrainHost {
	val drainGate: DrainGate
	val state: MutableStateFlow<ChatState>
	val isVisible: Boolean
	val autoGenerate: Boolean

	fun link(): ConsoleLink
	fun plan(visible: Boolean, socket: Boolean, failed: Boolean): ConsoleTransportPlan
	fun thisDeviceAddress(): Address?
	fun fromCanonical(value: String): String?
	fun advanceMailbox(result: SyncPollResult<Drained>): SyncAdvance<Drained>
	fun setGap(value: Boolean)
	fun markCommsActivity(now: Long)
	fun reconcileSent(team: String, message: Message)
	fun appendInbound(team: String, message: Message, beforeCommit: () -> Unit = {}): Boolean
	fun autoPlayTier(): SttsPlayer.Tier?
	fun isSttsReady(): Boolean
	fun onInbound(team: String, messages: List<Message>)
	fun preloadMessage(team: String, at: Long)
	suspend fun enqueueForPlay(team: String, at: Long, tier: SttsPlayer.Tier)
	fun commitMailbox(cursor: SyncCursor)
	fun decodeAttachments(files: List<ChannelFile>?): List<MessageFile>
	fun fetchPendingAttachments()
	suspend fun dispatchInboxRows(rows: List<InboxRow>)
	suspend fun applyPlane(name: String, payload: JsonElement?): Boolean

	suspend fun poll(known: Map<String, Long>): TickOutcome
	/** Planes newer than the held versions. */
	suspend fun readPlanes(held: JsonObject): List<PlaneRead>?
}

internal class ChatRepositoryDrainHost(private val repo: ChatRepository) : DrainHost {
	override val drainGate get() = repo.drainGate
	override val state get() = repo._state
	override val isVisible get() = repo.isVisible
	override val autoGenerate get() = repo.sttsAutoGen
	override fun link() = repo.transportCoordinator.link()
	override fun plan(visible: Boolean, socket: Boolean, failed: Boolean) =
		repo.transportCoordinator.plan(visible, socket, failed)
	override fun thisDeviceAddress() = repo.thisDeviceAddress()
	override fun fromCanonical(value: String) = repo.fromCanonical(value)
	override fun advanceMailbox(result: SyncPollResult<Drained>) = repo.mailboxSync.advance(result)
	override fun setGap(value: Boolean) { repo._state.update { it.copy(gap = value) } }
	override fun markCommsActivity(now: Long) { repo.pushback.onCommsActivity(now, repo.isVisible) }
	override fun reconcileSent(team: String, message: Message) = repo.reconcileSent(team, message)
	override fun appendInbound(team: String, message: Message, beforeCommit: () -> Unit) =
		repo.appendInbound(team, message, beforeCommit)
	override fun autoPlayTier() = repo.playback.autoPlayTier(repo.sttsAutoPlay)
	override fun isSttsReady() = repo.sttsReady()
	override fun onInbound(team: String, messages: List<Message>) { repo.onInbound?.invoke(team, messages) }
	override fun preloadMessage(team: String, at: Long) { repo.playback.preloadMessage(team, at) }
	override suspend fun enqueueForPlay(team: String, at: Long, tier: SttsPlayer.Tier) {
		repo.playback.enqueueForPlay(team, at, tier, announceRun = true)
	}
	override fun commitMailbox(cursor: SyncCursor) { repo.mailboxSync.commit(cursor) }
	override fun decodeAttachments(files: List<ChannelFile>?) = Attachments.decode(files)
	override fun fetchPendingAttachments() { repo.attachments.fetchPendingAttachments() }
	override suspend fun dispatchInboxRows(rows: List<InboxRow>) { repo.dispatchInboxRows(rows) }
	override suspend fun applyPlane(name: String, payload: JsonElement?) = repo.applyPlane(name, payload)

	override suspend fun poll(known: Map<String, Long>) = drainTick(
		repo.client(),
		repo.transportCoordinator,
		known,
		onRows = { dispatchInboxRows(it) },
		onPlane = { name, _, payload -> applyPlane(name, payload) },
	)

	override suspend fun readPlanes(held: JsonObject) = repo.client().planesRead(held)?.planes
}
