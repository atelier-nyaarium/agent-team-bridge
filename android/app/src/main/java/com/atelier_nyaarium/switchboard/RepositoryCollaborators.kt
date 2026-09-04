package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.SignedDeleteDomain
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter

internal class ChatRepositoryEnrollCeremonyCollaborators(private val repo: ChatRepository) : EnrollCeremonyOpsCollaborators {
	override fun enrollInvites() = repo.enrollInvites
	override fun ownerBoxPub() = repo.federation.ownerBoxPub()
	override fun freshEnrollSalt() = repo.federation.freshEnrollSalt()
	override fun addTrustedOwner(ownerSignPub: String) = repo.federation.addTrustedOwner(ownerSignPub)
	override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String) =
		repo.ownerFacts.submitXdomainLink(srcDomainId, dstDomainId, edgeNonce)
}

internal class ChatRepositoryDeviceApprovalCollaborators(private val repo: ChatRepository) : DeviceApprovalOpsCollaborators {
	override fun approvalNonces() = repo.approvalNonces
	override fun homeGatewayId() = repo.homeGatewayId
	override fun setHomeGatewayId(value: String) {
		repo.homeGatewayId = value
	}
	override fun installApprovedDevice(
		blob: String,
		domainJson: String?,
		domainVersion: String?,
		gatewayId: String?,
		contentKeys: Map<Int, ByteArray>,
		domainId: String?,
	) = repo.identity.installApproved(blob, domainJson, domainVersion, gatewayId, contentKeys, domainId)
	override fun invalidateClients() {
		repo.client = null
		repo.sttsClient = null
	}
	override suspend fun submitOwnerAdmission(signed: SignedAdmission) =
		repo.ownerFacts.submitOwnerFact(
		 signed,
		 { repo.client().enroll(com.atelier_nyaarium.switchboard.proto.EnrollOp.SubmitAdmission(it)) },
		 repo.identity::mergeAdmission,
		"Approve failed",
	)
	override fun refreshAdmittedGateways() = repo.refreshAdmittedGateways()
	override fun reportError() = repo._state.value.error
}

internal class ChatRepositoryDomainAdminCollaborators(private val repo: ChatRepository) : DomainAdminOpsCollaborators {
	override fun enrollInvites() = repo.enrollInvites
	override fun ownerBoxPub() = repo.federation.ownerBoxPub()
	override fun freshHandshakeId() = repo.federation.freshHandshakeId()
	override fun freshEnrollPin() = repo.federation.freshEnrollPin()
	override fun newDomainId() = repo.federation.newDomainId()
	override fun signSetDisplayName(domainId: String, name: String, nowMs: Long): SignedSetDisplayName =
		repo.federation.signSetDisplayName(domainId, name, nowMs)
	override fun signDeleteDomain(domainId: String, nowMs: Long): SignedDeleteDomain =
		repo.federation.signDeleteDomain(domainId, nowMs)
	override fun signProvisionTenant(domainId: String, name: String, nowMs: Long): SignedProvisionTenant =
		repo.federation.signProvisionTenant(domainId, name, nowMs)
	override fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant =
		repo.federation.signRemoveTenant(domainId, nowMs)
	override suspend fun clearAll() {
		repo.clearAll()
	}
}

internal class ChatRepositoryGoalCollaborators(private val repo: ChatRepository) : GoalOpsCollaborators {
	override suspend fun send(team: String, text: String, uris: List<Uri>) = repo.send(team, text, uris)
	override suspend fun peekTerminal(team: String): Result<ConsolePeekResult> = repo.sessions.peekTerminal(team, null)
	override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) =
		repo.sessions.tmuxSend(team, text, key, submit)
}

internal class ChatRepositoryScheduledSendCollaborators(private val repo: ChatRepository) : ScheduledSendOpsCollaborators {
	override fun admitPicked(uris: List<Uri>, bucket: String) = repo.admitPicked(uris, bucket)
	override fun canonicalTarget(team: String) = repo.canonicalTarget(team)
	override fun scheduleAttachmentDelete(srcs: List<String>) = repo.attachments.scheduleAttachmentDelete(srcs)
	override fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) = repo.takeBackIntoDraft(team, text, files)
	override fun append(team: String, message: Message) = repo.append(team, message)
	override fun rebuildFiles(files: List<MessageFile>) = repo.rebuildFiles(files)
	override suspend fun deliver(
		team: String,
		echoId: Long,
		text: String,
		files: List<OutgoingFile>,
		opId: String,
		targetDomainId: String?,
	) = repo.deliver(team, echoId, text, files, opId, false, targetDomainId)
	override suspend fun retrySend(team: String, messageId: Long, targetDomainId: String?) =
		repo.retrySend(team, messageId, targetDomainId)
}

internal class ChatRepositoryAttachmentCollaborators(private val repo: ChatRepository) : AttachmentOpsCollaborators {
	override fun clientOrNull() = repo.client
	override suspend fun routerBlobRange(domainId: String, blobId: String, offset: Long, originGateway: String?) =
		repo.routerBlobRange(domainId, blobId, offset, originGateway)
	override fun attachmentBuckets() = repo.boardOps.attachmentBuckets()
}

internal class ChatRepositoryBoardCollaborators(private val repo: ChatRepository) : BoardOpsCollaborators {
	override val board: BoardManager get() = repo.board
	override val sessions: SessionOps get() = repo.sessions
	override val attachmentHost: AttachmentHost get() = repo.attachmentHost
	override val boardRouter: BoardRouterWriter get() = repo.boardRouter
	override fun boardSealing() = repo.boardSealing()
	override fun admitPicked(uris: List<Uri>, name: String) = repo.admitPicked(uris, name)
	override fun localDomain() = repo.localDomain()
	override val client: ConsoleClient? get() = repo.client
	override fun command(block: () -> Unit) = repo.command { block() }
}

internal class ChatRepositoryTrustCollaborators(private val repo: ChatRepository) : TrustOpsCollaborators {
	override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String) =
		repo.ownerFacts.submitXdomainLink(srcDomainId, dstDomainId)
	override suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String) =
		repo.ownerFacts.revokeXdomainLink(srcDomainId, dstDomainId)
}

internal class ChatRepositoryPlaybackPort(private val repo: ChatRepository) : PlaybackPort {
	override val stts: SttsPlayer get() = repo.stts
	override fun sttsClient() = repo.sttsClient()
	override fun currentProvider(): SttsProvider? = repo.currentProvider()
	override fun sttsVoiceFor(providerId: String) = repo.sttsVoiceFor(providerId)
	override val sttsVolume: Int get() = repo.sttsVolume
	override val sttsChimeVolume: Int get() = repo.sttsChimeVolume
	override val sttsAutoPlay: String get() = repo.sttsAutoPlay
	override fun sttsReady() = repo.sttsReady()
}

internal class ChatRepositoryPlaybackCollaborators(private val repo: ChatRepository) : PlaybackOpsCollaborators {
	override fun openThread(team: String) = repo.openThread(team)
}
