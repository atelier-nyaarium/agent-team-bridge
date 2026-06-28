// generated from src/shared/schemas.ts + src/shared/console-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
//
// Decode with Json { ignoreUnknownKeys = true } (the additive-protocol
// posture). Enum-like fields are open Strings on purpose: the console must
// tolerate values newer than this build.
//
// ENCODE config is load-bearing: the default Json (encodeDefaults = false)
// omits null-defaulted optionals, which is exactly what the gateway's zod
// schemas accept - zod .optional() REJECTS explicit nulls. If encodeDefaults
// is ever enabled (e.g. to emit a defaulted const like ConsoleRelayFrame.type),
// it MUST pair with explicitNulls = false. Note the console's POST body is the
// op-only envelope {device, conversationId, opId, op}; evie composes the full
// console_relay frame, so ConsoleRelayFrame is decode-side here.
@file:Suppress("unused")

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
	const val CONSOLE_PROTOCOL_VERSION: Int = 1

	/** The one structural separator for every address / store / thread key. */
	const val ADDRESS_SEP: String = "."

	/** Position-0 store-key tag for a channel conversation key. */
	const val CONV_TAG: String = "conv"

	/** Position-0 store-key tag for a broadcast notice key. */
	const val NOTICE_TAG: String = "notice"

	/** The session a bare spawn-point name defaults to as a wake / UI default. */
	const val DEFAULT_SESSION: String = "claude"

	/** The one address-segment slug pattern (lowercase alnum, internal / trailing hyphen). */
	const val SLUG_PATTERN: String = "^[a-z0-9][a-z0-9-]*\$"

	const val MAX_SLUG_LEN: Int = 64

	const val MAX_CONV_ID_LEN: Int = 128
}

@Serializable
data class ChannelFile(
	val filename: String,
	val mime: String,
	val size: Long,
	val descriptiveKey: String,
	val base64: String? = null,
)

@Serializable
data class TeamInfo(
	val team: String,
	val gatewayId: String,
	val domainId: String? = null,
	val displayName: String? = null,
	val isAdminDomain: Boolean? = null,
	val status: String,
	val mode: String? = null,
	val kind: String,
	val version: String? = null,
	val lastActive: Long? = null,
	val queue_depth: Long,
)

@Serializable
data class MailboxEntry(
	val seq: Long,
	val at: Long,
	val kind: String,
	val session_id: String,
	val from: String? = null,
	val opId: String? = null,
	val title: String? = null,
	val summary: String? = null,
	val body: String? = null,
	val status: String? = null,
	val replyAsJson: JsonObject? = null,
	val question: String? = null,
	val reason: String? = null,
	val request_type: String? = null,
	val effort: String? = null,
	val is_follow_up: Boolean? = null,
	val files: List<ChannelFile>? = null,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("kind")
sealed class CrossDomainShareTarget {
	@Serializable
	@SerialName("domain")
	data class Domain(
		val domainId: String,
	) : CrossDomainShareTarget()

	@Serializable
	@SerialName("everyone_trusted")
	data object EveryoneTrusted : CrossDomainShareTarget()
}

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("kind")
sealed class ConsoleOp {
	@Serializable
	@SerialName("register")
	data class Register(
		val clientVersion: String? = null,
		val clientVariant: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("first_root")
	data class FirstRoot(
		val firstRoot: SignedFirstRoot,
	) : ConsoleOp()

	@Serializable
	@SerialName("list_teams")
	data object ListTeams : ConsoleOp()

	@Serializable
	@SerialName("send")
	data class Send(
		val to: String,
		val domainId: String? = null,
		val request_type: String? = null,
		val effort: String? = null,
		val body: String,
		val files: List<ChannelFile>? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("respond")
	data class Respond(
		val session_id: String,
		val status: String? = null,
		val response: String? = null,
		val replyAsJson: JsonObject? = null,
		val files: List<ChannelFile>? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("poll")
	data class Poll(
		val cursor: Long? = null,
		val epoch: Long? = null,
		val holdMs: Long? = null,
		val knownDomainVersion: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("peek")
	data class Peek(
		val target: String,
		val sinceHash: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("tmux_send")
	data class TmuxSend(
		val target: String,
		val text: String? = null,
		val key: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("create_session")
	data class CreateSession(
		val target: String,
		val sessionName: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("reload_plugins")
	data class ReloadPlugins(
		val target: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("forget")
	data class Forget(
		val target: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_listen")
	data object CrossDomainListen : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_request")
	data class CrossDomainRequest(
		val listeningToken: String,
		val pin: String,
		val requesterOwnerSignPub: String,
		val requesterDomainId: String,
		val requesterGatewayId: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_confirm")
	data class CrossDomainConfirm(
		val pin: String,
		val mySignedLink: SignedXDomainLink,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_listen_state")
	data class CrossDomainListenState(
		val listeningToken: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_cancel")
	data class CrossDomainCancel(
		val listeningToken: String? = null,
		val pin: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_share")
	data class CrossDomainShare(
		val sessionTarget: String,
		val target: CrossDomainShareTarget,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_unshare")
	data class CrossDomainUnshare(
		val sessionTarget: String,
		val target: CrossDomainShareTarget,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_list_shares")
	data object CrossDomainListShares : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_list_peers")
	data object CrossDomainListPeers : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_unlink")
	data class CrossDomainUnlink(
		val domainId: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("cross_domain_untrust")
	data class CrossDomainUntrust(
		val ownerSignPub: String,
	) : ConsoleOp()
}

@Serializable
data class ConsoleOpEnvelope(
	val v: Long,
	val conversationId: String,
	val device: String,
	val at: Long,
	val op: ConsoleOp,
)

@Serializable
data class ConsoleRelayFrame(
	val type: String = "console_relay",
	val v: Long,
	val opId: String,
	val signerSignPub: String,
	val targetGateway: String? = null,
	val sealed: SealedEnvelope,
)

@Serializable
data class ConsoleRelayReply(
	val type: String = "console_relay_reply",
	val v: Long,
	val opId: String,
	val sealed: SealedEnvelope? = null,
	val error: String? = null,
)

@Serializable
data class ConsoleReplyBody(
	val ok: Boolean,
	val result: JsonElement? = null,
	val error: String? = null,
)

@Serializable
data class ConsoleRegisterResult(
	val device: String,
	val gatewayId: String,
	val cursor: Long,
	val epoch: Long,
	val domainStatus: String? = null,
)

@Serializable
data class ConsoleListTeamsResult(
	val teams: List<TeamInfo>,
)

@Serializable
data class ConsoleSendResult(
	val session_id: String,
	val status: String,
)

@Serializable
data class ConsoleRespondResult(
	val delivered: Boolean,
)

@Serializable
data class ConsolePollResult(
	val entries: List<MailboxEntry>,
	val cursor: Long,
	val dropped: Long,
	val epoch: Long,
	val domainVersion: String? = null,
	val domain: DomainSnapshot? = null,
)

@Serializable
data class ConsolePeekResult(
	val ansi: String? = null,
	val hash: String,
	val unchanged: Boolean? = null,
)

@Serializable
data class ConsoleTmuxSendResult(
	val sent: Boolean,
)

@Serializable
data class Provisioning(
	val apiUrl: String,
	val caPem: String,
	val saToken: String,
	val appToken: String? = null,
	val namespace: String? = null,
	val service: String? = null,
	val port: Long? = null,
	val device: String? = null,
	val conversationId: String? = null,
	val pendingTenant: PendingTenantRef? = null,
	val enrollHandshake: EnrollHandshakeRef? = null,
	val deviceApprovalReach: String? = null,
)

@Serializable
data class SttsProviders(
	val providers: List<SttsProvider>,
)

@Serializable
data class Admission(
	val kind: String,
	val signPub: String,
	val boxPub: String,
	val gatewayId: String? = null,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedAdmission(
	val admission: Admission,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class Revocation(
	val signPub: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedRevocation(
	val revocation: Revocation,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("kind")
sealed class EnrollOp {
	@Serializable
	@SerialName("enroll_redeem")
	data class EnrollRedeem(
		val nonce: String,
		val ownerSignPub: String,
		val ownerBoxPub: String,
	) : EnrollOp()

	@Serializable
	@SerialName("submit_admission")
	data class SubmitAdmission(
		val admission: SignedAdmission,
	) : EnrollOp()

	@Serializable
	@SerialName("submit_revocation")
	data class SubmitRevocation(
		val revocation: SignedRevocation,
	) : EnrollOp()

	@Serializable
	@SerialName("submit_xdomain_link")
	data class SubmitXdomainLink(
		val edge: SignedXDomainLinkEdge,
	) : EnrollOp()

	@Serializable
	@SerialName("revoke_xdomain_link")
	data class RevokeXdomainLink(
		val revocation: SignedXDomainLinkRevocation,
	) : EnrollOp()

	@Serializable
	@SerialName("provision_tenant")
	data class ProvisionTenant(
		val provision: SignedProvisionTenant,
	) : EnrollOp()

	@Serializable
	@SerialName("remove_tenant")
	data class RemoveTenant(
		val removal: SignedRemoveTenant,
	) : EnrollOp()

	@Serializable
	@SerialName("set_display_name")
	data class SetDisplayName(
		val rename: SignedSetDisplayName,
	) : EnrollOp()

	@Serializable
	@SerialName("delete_domain")
	data class DeleteDomain(
		val deletion: SignedDeleteDomain,
	) : EnrollOp()
}

@Serializable
data class EnrollResult(
	val ok: Boolean,
	val error: String? = null,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("step")
sealed class EnrollHandshakeOp {
	@Serializable
	@SerialName("commit")
	data class Commit(
		val handshakeId: String,
		val role: String,
		val commitment: String,
	) : EnrollHandshakeOp()

	@Serializable
	@SerialName("reveal")
	data class Reveal(
		val handshakeId: String,
		val role: String,
		val reveal: EnrollReveal,
	) : EnrollHandshakeOp()

	@Serializable
	@SerialName("cancel")
	data class Cancel(
		val handshakeId: String,
		val role: String,
	) : EnrollHandshakeOp()
}

@Serializable
data class EnrollHandshakeResult(
	val ok: Boolean,
	val error: String? = null,
	val peerCommitment: String? = null,
	val peerReveal: EnrollReveal? = null,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("step")
sealed class ConsoleApprovalOp {
	@Serializable
	@SerialName("arm")
	data class Arm(
		val approvalId: String,
		val nonce: String,
	) : ConsoleApprovalOp()

	@Serializable
	@SerialName("join")
	data class Join(
		val approvalId: String,
		val nonce: String,
		val newSignPub: String,
		val newBoxPub: String,
		val device: String? = null,
	) : ConsoleApprovalOp()

	@Serializable
	@SerialName("poll")
	data class Poll(
		val approvalId: String,
	) : ConsoleApprovalOp()

	@Serializable
	@SerialName("approve")
	data class Approve(
		val approvalId: String,
		val sealed: SealedEnvelope,
	) : ConsoleApprovalOp()

	@Serializable
	@SerialName("fetch")
	data class Fetch(
		val approvalId: String,
		val nonce: String,
	) : ConsoleApprovalOp()

	@Serializable
	@SerialName("cancel")
	data class Cancel(
		val approvalId: String,
	) : ConsoleApprovalOp()
}

@Serializable
data class ConsoleApprovalResult(
	val ok: Boolean,
	val error: String? = null,
	val join: ConsoleApprovalJoin? = null,
	val sealed: SealedEnvelope? = null,
)

@Serializable
data class PendingTenant(
	val domainId: String,
	val displayName: String,
	val nonce: String,
	val issuedAt: Long,
	val ttlMs: Long,
	val rooted: Boolean,
)

@Serializable
data class GatewayTransport(
	val apiUrl: String,
	val saToken: String,
	val caPem: String,
	val appToken: String? = null,
)

@Serializable
data class GatewayBootstrapBundle(
	val nonce: String,
	val transport: GatewayTransport,
	val admission: SignedAdmission,
	val domain: DomainSnapshot,
	val domainId: String? = null,
)

@Serializable
data class GatewayBootstrapFrame(
	val v: Long,
	val signerSignPub: String,
	val sealed: SealedEnvelope,
)

@Serializable
data class SignedXDomainUntrust(
	val untrust: XDomainUntrust,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class RosterRequest(
	val signerSignPub: String,
	val proofAt: Long,
	val nonce: String,
	val proof: String,
)

@Serializable
data class RosterResult(
	val ok: Boolean,
	val error: String? = null,
	val members: List<RosterMember>? = null,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("step")
sealed class TrustHandshakeOp {
	@Serializable
	@SerialName("arm")
	data class Arm(
		val rendezvousId: String,
		val initiatorOwnerSignPub: String,
		val targetOwnerSignPub: String,
		val commitment: String,
	) : TrustHandshakeOp()

	@Serializable
	@SerialName("join")
	data class Join(
		val rendezvousId: String,
		val joinerOwnerSignPub: String,
		val commitment: String,
	) : TrustHandshakeOp()

	@Serializable
	@SerialName("reveal")
	data class Reveal(
		val rendezvousId: String,
		val side: String,
		val reveal: EnrollReveal,
	) : TrustHandshakeOp()

	@Serializable
	@SerialName("cancel")
	data class Cancel(
		val rendezvousId: String,
	) : TrustHandshakeOp()
}

@Serializable
data class TrustHandshakeResult(
	val ok: Boolean,
	val error: String? = null,
	val peerCommitment: String? = null,
	val peerReveal: EnrollReveal? = null,
)

@Serializable
data class TrustPendingRequest(
	val signerSignPub: String,
	val proofAt: Long,
	val nonce: String,
	val proof: String,
)

@Serializable
data class TrustPendingResult(
	val ok: Boolean,
	val error: String? = null,
	val pending: List<TrustPendingEntry>? = null,
)

@Serializable
data class TransportRequest(
	val signerSignPub: String,
	val proofAt: Long,
	val nonce: String,
	val proof: String,
)

@Serializable
data class TransportResult(
	val ok: Boolean,
	val saToken: String? = null,
	val caPem: String? = null,
	val error: String? = null,
)

@Serializable
data class SignedFirstRoot(
	val firstRoot: FirstRoot,
	val signature: String,
)

@Serializable
data class FirstRoot(
	val domainId: String,
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val nonce: String,
	val issuedAt: Long,
)

@Serializable
data class SignedXDomainLink(
	val link: XDomainLink,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class XDomainLink(
	val myOwnerSignPub: String,
	val peerOwnerSignPub: String,
	val peerDomainId: String,
	val peerGatewayId: String,
	val peerSignPub: String,
	val peerBoxPub: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SealedEnvelope(
	val ephemeralPub: String,
	val nonce: String,
	val ciphertext: String,
	val signature: String,
)

@Serializable
data class DomainSnapshot(
	val ownerSignPub: String,
	val admissions: List<SignedAdmission>,
	val revocations: List<SignedRevocation>,
	val displayName: String? = null,
)

@Serializable
data class ConsoleCreateSessionResult(
	val created: Boolean,
)

@Serializable
data class ConsoleReloadPluginsResult(
	val initiated: Boolean,
)

@Serializable
data class ConsoleForgetResult(
	val killed: Boolean,
)

@Serializable
data class CrossDomainListenResult(
	val listeningToken: String,
	val receiverOwnerSignPub: String,
	val receiverGatewaySignPub: String,
	val receiverGatewayBoxPub: String,
	val receiverDomainId: String,
	val receiverGatewayId: String,
	val expiresAt: Long,
)

@Serializable
data class CrossDomainRequestResult(
	val sas: String,
	val requesterOwnerSignPub: String,
	val receiverOwnerSignPub: String,
	val receiverDomainId: String,
	val receiverGatewayId: String,
	val receiverGatewaySignPub: String,
	val receiverGatewayBoxPub: String,
)

@Serializable
data class CrossDomainConfirmResult(
	val ok: Boolean,
)

@Serializable
data class CrossDomainCancelResult(
	val cancelled: Boolean,
)

@Serializable
data class CrossDomainListenStateResult(
	val pairingArrived: Boolean,
	val pin: String? = null,
	val sas: String? = null,
	val friendOwnerSignPub: String? = null,
	val friendGatewaySignPub: String? = null,
	val friendGatewayBoxPub: String? = null,
	val friendDomainId: String? = null,
	val friendGatewayId: String? = null,
	val expiresAt: Long? = null,
	val expired: Boolean? = null,
)

@Serializable
data class CrossDomainShareResult(
	val ok: Boolean,
)

@Serializable
data class CrossDomainUnshareResult(
	val ok: Boolean,
)

@Serializable
data class CrossDomainListSharesResult(
	val shares: List<CrossDomainShareEntry>,
)

@Serializable
data class CrossDomainShareEntry(
	val sessionTarget: String,
	val target: CrossDomainShareTarget,
)

@Serializable
data class CrossDomainListPeersResult(
	val peers: List<CrossDomainPeerEntry>,
)

@Serializable
data class CrossDomainPeerEntry(
	val domainId: String,
	val gatewayId: String,
	val ownerSignPub: String,
)

@Serializable
data class CrossDomainUnlinkResult(
	val peersRemoved: Long,
	val sharesDropped: Long,
	val jobsExpired: Long,
)

@Serializable
data class PendingTenantRef(
	val domainId: String,
	val nonce: String,
)

@Serializable
data class EnrollHandshakeRef(
	val adminOwnerSignPub: String,
	val adminOwnerBoxPub: String,
	val adminDomainId: String,
	val handshakeId: String,
	val pin: String,
)

@Serializable
data class SttsProvider(
	val id: String,
	val label: String,
	val path: String,
	val hasSample: Boolean,
	val container: String? = null,
	val request: JsonObject,
	val defaults: SttsDefaults,
	val voices: List<SttsVoice>,
	val voiceHint: String,
	val note: String? = null,
)

@Serializable
data class SttsDefaults(
	val voice: String,
)

@Serializable
data class SttsVoice(
	val id: String,
	val label: String? = null,
)

@Serializable
data class SignedXDomainLinkEdge(
	val edge: XDomainLinkEdge,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class XDomainLinkEdge(
	val srcDomainId: String,
	val dstDomainId: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedXDomainLinkRevocation(
	val revocation: XDomainLinkRevocation,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class XDomainLinkRevocation(
	val srcDomainId: String,
	val dstDomainId: String,
	val revokedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedProvisionTenant(
	val provision: ProvisionTenant,
	val adminSignPub: String,
	val signature: String,
)

@Serializable
data class ProvisionTenant(
	val domainId: String,
	val displayName: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedRemoveTenant(
	val removal: RemoveTenant,
	val adminSignPub: String,
	val signature: String,
)

@Serializable
data class RemoveTenant(
	val domainId: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedSetDisplayName(
	val rename: SetDisplayName,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class SetDisplayName(
	val domainId: String,
	val displayName: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class SignedDeleteDomain(
	val deletion: DeleteDomain,
	val ownerSignPub: String,
	val signature: String,
)

@Serializable
data class DeleteDomain(
	val domainId: String,
	val issuedAt: Long,
	val nonce: String,
)

@Serializable
data class EnrollReveal(
	val ownerSignPub: String,
	val ownerBoxPub: String,
	val domainId: String,
	val salt: String,
)

@Serializable
data class ConsoleApprovalJoin(
	val newSignPub: String,
	val newBoxPub: String,
	val device: String? = null,
)

@Serializable
data class XDomainUntrust(
	val myOwnerSignPub: String,
	val peerOwnerSignPub: String,
	val revokedAt: Long,
	val nonce: String,
)

@Serializable
data class RosterMember(
	val ownerSignPub: String,
	val displayName: String,
	val online: Boolean,
)

@Serializable
data class TrustPendingEntry(
	val initiatorOwnerSignPub: String,
	val rendezvousId: String,
)
