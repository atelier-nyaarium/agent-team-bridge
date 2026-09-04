// generated from src/shared/schemas.ts + src/shared/console-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
// Decode with ignoreUnknownKeys = true. Enum-like fields are open Strings, so a console
// tolerates values newer than its build.
//
// Keep encodeDefaults false: zod .optional() rejects an explicit null. Enabling it MUST pair
// with explicitNulls = false. Required consts become parameters.
//
@file:Suppress("unused")
@file:OptIn(ExperimentalSerializationApi::class)

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
	const val CONSOLE_PROTOCOL_VERSION: Int = 3
	const val FEDERATION_PROTOCOL_FLOOR: Int = 1
	const val FEDERATION_PROTOCOL_VERSION: Int = 2

	object Wire {
		const val ROUTER_PATH_CONSOLE: String = "/console"
		const val ROUTER_PATH_HEALTH: String = "/health"
		const val ROUTER_PATH_INGEST: String = "/ingest"
		const val ROUTER_PATH_DEVICE_APPROVAL: String = "/device-approval"
		const val ROUTER_PATH_GATEWAY: String = "/gateway"
		const val ROUTER_PATH_ROOT: String = "/"
		const val CONSOLE_TOKEN_HEADER: String = "x-console-bridge-token"
		const val BEARER_PREFIX: String = "Bearer "
		const val OWNER_OP_DELIVER: String = "deliver"
		const val OWNER_OP_CONSUMER_REGISTER: String = "consumer_register"
		const val OWNER_OP_INBOX_READ: String = "inbox_read"
		const val OWNER_OP_INBOX_ADVANCE: String = "inbox_advance"
		const val OWNER_OP_OP_RESULT: String = "op_result"
		const val OWNER_OP_HELLO: String = "hello"
		const val OWNER_OP_BLOB_FETCH: String = "blob_fetch"
		const val OWNER_OP_GATEWAY_VALUE: String = "gateway_value"
		const val OWNER_OP_PLANES_READ: String = "planes_read"
		const val OWNER_OP_REPORT_READ: String = "report_read"
		const val OWNER_OP_KEY_REQUEST: String = "key_request"
		const val OWNER_OP_KEY_GRANT: String = "key_grant"
		const val OWNER_OP_KEY_RECEIPT: String = "key_receipt"
		const val OWNER_OP_KEY_RECEIPTS_READ: String = "key_receipts_read"
		const val OWNER_OP_BOARD_READ: String = "board_read"
		const val OWNER_OP_BOARD_WRITE: String = "board_write"
		const val SIGNING_TAG_ADMISSION: String = "ADMISSION_V1"
		const val SIGNING_TAG_REVOCATION: String = "REVOCATION_V1"
		const val SIGNING_TAG_REGISTER: String = "REGISTER_V1"
		const val SIGNING_TAG_DEVICE_JOIN: String = "DEVICE_JOIN_V1"
		const val SIGNING_TAG_OWNER_OP: String = "OWNEROP_V1"
		const val SIGNING_TAG_INBOX_ROW: String = "INBOXROW_V1"
		const val SIGNING_TAG_KEY_ENVELOPE: String = "KEYENVELOPE_V1"
		const val SIGNING_TAG_KEY_REQUEST: String = "KEYREQUEST_V1"
		const val SIGNING_TAG_KEY_RECEIPT: String = "KEYRECEIPT_V1"
		const val SIGNING_TAG_ROSTER: String = "ROSTER_V1"
		const val SIGNING_TAG_TRUST_PENDING: String = "TRUST_PENDING_V1"
		const val SIGNING_TAG_TRANSPORT_REQUEST: String = "TRANSPORT_REQUEST_V1"
		const val SIGNING_TAG_PROVISION_TENANT: String = "PROVISION_TENANT_V1"
		const val SIGNING_TAG_REMOVE_TENANT: String = "REMOVE_TENANT_V1"
		const val SIGNING_TAG_FIRST_ROOT: String = "FIRST_ROOT_V1"
		const val SIGNING_TAG_SET_DISPLAY_NAME: String = "SET_DISPLAY_NAME_V1"
		const val SIGNING_TAG_DELETE_DOMAIN: String = "DELETE_DOMAIN_V1"
		const val SIGNING_TAG_XDOMAIN_RELAY_GATE: String = "XDOMAIN_RELAY_GATE_V1"
		const val SIGNING_TAG_XDOMAIN_REVOKE: String = "XDOMAIN_REVOKE_V1"
		const val SIGNING_TAG_XDOMAIN_LINK: String = "XDOMAIN_LINK_V1"
		const val SIGNING_TAG_XDOMAIN_UNTRUST: String = "XDOMAIN_UNTRUST_V1"
		const val SIGNING_TAG_SAS_COMMIT: String = "SAS_COMMIT_V1"
		const val SIGNING_TAG_SAS: String = "SAS_V1"
		const val SIGNING_TAG_ENROLL_COMMIT: String = "ENROLL_COMMIT_V1"
		const val SIGNING_TAG_ENROLL_SAS: String = "ENROLL_SAS_V1"
		const val SIGNING_TAG_CODEX_AGENT: String = "CODEX_AGENT_V1"
		const val SIGNING_TAG_COPILOT_AGENT: String = "COPILOT_AGENT_V1"
		const val CONTENT_NONCE_BYTES: Int = 12
		const val WIRE_NONCE_BYTES: Int = 18

		object ConsoleOpKind {
			const val SEND: String = "send"
			const val RESPOND: String = "respond"
			const val REPORT_READ: String = "report_read"
			const val PEEK: String = "peek"
			const val TMUX_SEND: String = "tmux_send"
			const val CREATE_SESSION: String = "create_session"
			const val RELOAD_PLUGINS: String = "reload_plugins"
			const val FORGET: String = "forget"
			const val CLOSE_SESSION: String = "close_session"
			const val RENAME_SESSION: String = "rename_session"
			const val WAKE: String = "wake"
			const val LIST_DIRS: String = "list_dirs"
			const val BLOB_STAT: String = "blob_stat"
			const val BLOB_PUT: String = "blob_put"
			const val BLOB_GET: String = "blob_get"
			const val CROSS_DOMAIN_LISTEN: String = "cross_domain_listen"
			const val CROSS_DOMAIN_REQUEST: String = "cross_domain_request"
			const val CROSS_DOMAIN_CONFIRM: String = "cross_domain_confirm"
			const val CROSS_DOMAIN_LISTEN_STATE: String = "cross_domain_listen_state"
			const val CROSS_DOMAIN_CANCEL: String = "cross_domain_cancel"
			const val CROSS_DOMAIN_SHARE: String = "cross_domain_share"
			const val CROSS_DOMAIN_UNSHARE: String = "cross_domain_unshare"
			const val CROSS_DOMAIN_LIST_SHARES: String = "cross_domain_list_shares"
			const val CROSS_DOMAIN_LIST_PEERS: String = "cross_domain_list_peers"
			const val CROSS_DOMAIN_UNLINK: String = "cross_domain_unlink"
			const val CROSS_DOMAIN_UNTRUST: String = "cross_domain_untrust"
		}

		object SocketFrame {
			const val WELCOME: String = "welcome"
			const val INBOX_ROWS: String = "inbox_rows"
			const val PLANE: String = "plane"
			const val REFUSED: String = "refused"
			const val PONG: String = "pong"
		}

		object KeyOpKind {
			const val KEY_REQUEST: String = "key_request"
			const val KEY_GRANT: String = "key_grant"
			const val KEY_RECEIPT: String = "key_receipt"
			const val KEY_RECEIPTS_READ: String = "key_receipts_read"
		}
	}

	/** Address and store separator. */
	const val ADDRESS_SEP: String = "."

	/** Channel key tag. */
	const val CONV_TAG: String = "conv"

	/** Broadcast key tag. */
	const val NOTICE_TAG: String = "notice"

	/** Default session. */
	const val DEFAULT_SESSION: String = "claude"

	/** Address slug pattern. */
	const val SLUG_PATTERN: String = "^[a-z0-9][a-z0-9-]*\$"

	const val MAX_SLUG_LEN: Int = 64

	const val MAX_CONV_ID_LEN: Int = 128

	/** Blob chunk size. */
	const val BLOB_CHUNK_BYTES: Int = 1048576

	/** Blob size limit. Enforced where the bytes land: a stated size is the sender's claim. */
	const val MAX_BLOB_BYTES: Long = 500000000

	/** Unprompted fetch threshold, not an attachment cap. The wire still carries MAX_BLOB_BYTES. */
	const val BOARD_AUTO_DOWNLOAD_MAX_BYTES: Long = 25000000

	/** Board attachment limit. */
	const val BOARD_ATTACHMENTS_MAX: Int = 10
}

@Serializable
data class ChannelFile(
	val filename: String,
	val mime: String,
	val size: Long,
	val descriptiveKey: String,
	val modifiedAt: Long? = null,
	val blobId: String? = null,
	val blobGateway: String? = null,
	val role: String,
	val ref: RefFileMeta? = null,
	val cardTitle: String? = null,
	val cardGroup: String? = null,
	val cardWidth: Long? = null,
	val cardHeight: Long? = null,
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
	val sessionLabel: String? = null,
	val description: String? = null,
	val version: String? = null,
	val lastActive: Long? = null,
	val queue_depth: Long,
	val working: Boolean? = null,
	val needsLogin: Boolean? = null,
	val limitBlocked: Boolean? = null,
	val limitDetail: String? = null,
	val presenceFresh: String? = null,
)

@Serializable
data class MailboxEntry(
	val seq: Long,
	val at: Long,
	val kind: String,
	val session_id: String,
	val from: String? = null,
	val to: String? = null,
	val dedupeKey: String? = null,
	val opId: String? = null,
	val title: String? = null,
	val summary: String? = null,
	val body: String? = null,
	val fullSpoken: String? = null,
	val status: String? = null,
	val files: List<ChannelFile>? = null,
	val pluginId: String? = null,
	val actionType: String? = null,
	val payload: JsonObject? = null,
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
	@SerialName("send")
	data class Send(
		val to: String,
		val domainId: String? = null,
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
	@SerialName("report_read")
	data class ReportRead(
		val team: String,
		val epoch: Long,
		val seq: Long,
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
		val submit: Boolean? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("create_session")
	data class CreateSession(
		val target: String,
		val sessionName: String? = null,
		val displayLabel: String? = null,
		val workdir: String? = null,
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
		val boardDisposition: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("close_session")
	data class CloseSession(
		val target: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("rename_session")
	data class RenameSession(
		val target: String,
		val sessionLabel: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("wake")
	data class Wake(
		val target: String,
	) : ConsoleOp()

	@Serializable
	@SerialName("list_dirs")
	data class ListDirs(
		val path: String,
		val spawn: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("blob_stat")
	data class BlobStat(
		val blobId: String,
		val fromGateway: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("blob_put")
	data class BlobPut(
		val blobId: String,
		val offset: Long,
		val chunk: String,
		val final: Boolean,
	) : ConsoleOp()

	@Serializable
	@SerialName("blob_get")
	data class BlobGet(
		val blobId: String,
		val offset: Long,
		val length: Long,
		val fromGateway: String? = null,
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
data class ConsolePollResult(
	val entries: List<MailboxEntry>,
	val cursor: Long,
	val dropped: Long,
	val epoch: Long,
	val domainVersion: String? = null,
	val domain: DomainSnapshot? = null,
	val presence: List<TeamInfo>? = null,
	val presenceVersions: List<PresenceVersion>? = null,
	val linkedPeers: List<CrossDomainPeerEntry>? = null,
	val linkedPeersVersion: LinkedPeersVersion? = null,
	val readAnchors: List<ReadAnchorWireEntry>? = null,
	val readAnchorsVersion: ReadAnchorsVersion? = null,
	val taskBoard: List<BoardEntry>? = null,
	val taskBoardVersion: TaskBoardVersion? = null,
	val taskBoardTruncated: Boolean? = null,
	val crossDomainPresence: List<CrossDomainPresenceEntry>? = null,
	val settled: String? = null,
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
data class SignedFirstRoot(
	val firstRoot: FirstRoot,
	val signature: String,
)

@Serializable
data class CrossDomainPresenceEntry(
	val domainId: String,
	val version: CrossDomainPresenceVersion,
	val sessions: List<CrossDomainPresenceSession>,
	val lastRefreshedAt: Long,
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
data class ConsoleHelloFrame(
	@EncodeDefault
	val type: String = "hello",
	val ownerOp: OwnerOp,
	val mode: String? = null,
)

@Serializable
data class ConsoleAckFrame(
	@EncodeDefault
	val type: String = "ack",
	val incarnation: Long,
	val cursor: Long,
	val cursorEpoch: Long,
)

@Serializable
data class ConsolePingFrame(
	@EncodeDefault
	val type: String = "ping",
	val incarnation: Long,
)

@Serializable
data class ConsoleWelcomeFrame(
	@EncodeDefault
	val type: String = "welcome",
	val incarnation: Long,
	val cursor: Long,
	val cursorEpoch: Long,
	val floor: Long,
	val versions: JsonObject,
	val migrationEpoch: Long? = null,
)

@Serializable
data class ConsoleInboxRowsFrame(
	@EncodeDefault
	val type: String = "inbox_rows",
	val incarnation: Long,
	val rows: List<InboxRow>,
	val cursor: Long,
)

@Serializable
data class ConsolePlaneFrame(
	@EncodeDefault
	val type: String = "plane",
	val incarnation: Long,
	val name: String,
	val version: Long,
	val payload: JsonElement? = null,
)

@Serializable
data class ConsoleRefusedFrame(
	@EncodeDefault
	val type: String = "refused",
	val reason: String,
	val floor: Long? = null,
	val dropped: Long? = null,
)

@Serializable
data class ConsolePongFrame(
	@EncodeDefault
	val type: String = "pong",
	val incarnation: Long,
)

@Serializable
data class ConsolePeekResult(
	val ansi: String? = null,
	val text: String? = null,
	val kind: String? = null,
	val hash: String,
	val unchanged: Boolean? = null,
)

@Serializable
data class ConsoleTmuxSendResult(
	val sent: Boolean,
)

@Serializable
data class ConsoleCreateSessionResult(
	val created: Boolean,
	val id: String? = null,
	val sessionLabel: String? = null,
	val labelSanitized: Boolean? = null,
	val status: String? = null,
)

@Serializable
data class ConsoleReloadPluginsResult(
	val initiated: Boolean,
)

@Serializable
data class ConsoleForgetResult(
	val killed: Boolean,
	val boardDisposition: String? = null,
)

@Serializable
data class ConsoleReportReadResult(
	val advanced: Boolean,
)

@Serializable
data class ConsoleCloseSessionResult(
	val closed: Boolean,
)

@Serializable
data class ConsoleRenameSessionResult(
	val renamed: Boolean,
	val sessionLabel: String? = null,
)

@Serializable
data class ConsoleListDirsResult(
	val entries: List<String>,
	val truncated: Boolean? = null,
	val path: String? = null,
)

@Serializable
data class ConsoleBlobStatResult(
	val have: Long,
	val size: Long? = null,
	val complete: Boolean,
)

@Serializable
data class ConsoleBlobPutResult(
	val have: Long,
	val complete: Boolean,
)

@Serializable
data class ConsoleBlobGetResult(
	val chunk: String? = null,
	val eof: Boolean,
	val absent: Boolean? = null,
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
data class CrossDomainListPeersResult(
	val peers: List<CrossDomainPeerEntry>,
)

@Serializable
data class CrossDomainUnlinkResult(
	val peersRemoved: Long,
	val sharesDropped: Long,
	val jobsExpired: Long,
)

@Serializable
data class Provisioning(
	val routerUrl: String? = null,
	val routerCertFp: String? = null,
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
		val joinSig: String? = null,
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
	val routerUrl: String? = null,
	val routerCertFp: String? = null,
	val bearer: String? = null,
)

@Serializable
data class GatewayBootstrapBundle(
	val nonce: String,
	val transport: GatewayTransport,
	val admission: SignedAdmission,
	val domain: DomainSnapshot,
	val domainId: String? = null,
	val contentKeys: List<KeyEnvelope>? = null,
)

@Serializable
data class GatewayBootstrapFrame(
	val v: Long,
	val signerSignPub: String,
	val sealed: SealedEnvelope,
)

@Serializable
data class ContentEnvelope(
	val v: Long,
	val epoch: Long,
	val nonce: String,
	val ciphertext: String,
)

@Serializable
data class KeyEnvelope(
	val epoch: Long,
	val signerSignPub: String,
	val sealed: SealedEnvelope,
)

@Serializable
data class KeyRequest(
	val v: Long,
	val domainId: String,
	val requesterSignPub: String,
	val epochs: List<Long>,
	val at: Long,
	val nonce: String,
	val signature: String,
)

@Serializable
data class KeyGrant(
	val v: Long,
	val recipientSignPub: String,
	val envelope: KeyEnvelope,
	val at: Long,
)

@Serializable
data class KeyReceipt(
	val v: Long,
	val domainId: String,
	val recipientSignPub: String,
	val epoch: Long,
	val at: Long,
	val nonce: String,
	val signature: String,
)

@Serializable
data class KeyRequestOp(
	@EncodeDefault
	val kind: String = "key_request",
	val request: KeyRequest,
)

@Serializable
data class KeyGrantOp(
	@EncodeDefault
	val kind: String = "key_grant",
	val grant: KeyGrant,
)

@Serializable
data class KeyReceiptOp(
	@EncodeDefault
	val kind: String = "key_receipt",
	val receipt: KeyReceipt,
)

@Serializable
data class KeyReceiptsReadOp(
	@EncodeDefault
	val kind: String = "key_receipts_read",
)

@Serializable
data class KeyReceiptEntry(
	val recipientSignPub: String,
	val epoch: Long,
	val at: Long,
)

@Serializable
data class KeyReceiptsReadResult(
	val receipts: List<KeyReceiptEntry>,
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
	val routerUrl: String? = null,
	val routerCertFp: String? = null,
	val bearer: String? = null,
	val error: String? = null,
)

@Serializable
data class OwnerOp(
	val v: Long,
	val domainId: String,
	val signerSignPub: String,
	val conversationId: String,
	val device: String,
	val opId: String,
	val at: Long,
	val nonce: String,
	val op: JsonObject,
	val signature: String,
)

@Serializable
data class GatewayValueOp(
	@EncodeDefault
	val kind: String = "gateway_value",
	val gatewayId: String,
	val value: ContentEnvelope,
)

@Serializable
data class PlaneRead(
	val name: String,
	val version: Long,
	val payload: JsonElement? = null,
)

@Serializable
data class PlanesReadResult(
	val planes: List<PlaneRead>,
)

@Serializable
data class PlanesReadValue(
	@EncodeDefault
	val kind: String = "planes_read",
	val known: JsonObject,
)

@Serializable
data class InboxRow(
	val envelope: RowEnvelope,
	val producerSig: String,
	val body: JsonElement,
	val seq: Long,
	val acceptedAt: Long,
	val size: Long,
)

@Serializable
data class RowEnvelope(
	val origin: RowOrigin,
	val opKey: OpKey,
	val epoch: JsonElement,
	val kind: String,
	val contentRefs: List<String>,
)

@Serializable
data class RowOrigin(
	val kind: String,
	val domainId: String,
	val gatewayId: String? = null,
	val sessionId: String? = null,
	val device: String? = null,
)

@Serializable
data class OpKey(
	val conversationId: String,
	val opId: String,
	val hash: String? = null,
)

@Serializable
data class OpResultEnvelope(
	val opKey: OpKey,
	val outcome: String,
	val result: JsonElement? = null,
	val seq: Long? = null,
	val reason: String? = null,
)

@Serializable
data class OwnerPresenceProjection(
	val plane: PresencePlane,
	val rows: List<TeamInfo>,
	val linked: List<CrossDomainPresenceEntry>,
	val roster: List<RosterEntry>,
	val coverage: DiscoverCoverage,
	val spawnPoints: List<GatewaySpawnPoints>,
)

@Serializable
data class FriendPresenceProjection(
	val plane: PresencePlane,
	val sessions: List<CrossDomainPresenceSession>,
)

@Serializable
data class RosterEntry(
	val gatewayId: String,
	val connected: Boolean,
	val incarnation: Long,
	val lastRegisteredAt: Long,
)

@Serializable
data class CrossDomainShareValue(
	val sessionTarget: String,
	val target: CrossDomainShareTarget,
)

@Serializable
data class CrossDomainUnshareValue(
	val sessionTarget: String,
	val target: CrossDomainShareTarget,
)

@Serializable
data class CrossDomainUnlinkValue(
	val domainId: String,
)

@Serializable
data class BoardStoredEntry(
	val clear: BoardEntryClear,
	val sealed: BoardEntrySealed,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("kind")
sealed class BoardActor {
	@Serializable
	@SerialName("owner")
	data object Owner : BoardActor()

	@Serializable
	@SerialName("session")
	data class Session(
		val session: BoardSession,
	) : BoardActor()
}

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("kind")
sealed class BoardOp {
	@Serializable
	@SerialName("upsert")
	data class Upsert(
		val id: String,
		val state: String,
		val parent: String? = null,
		val rank: String,
		val session: BoardSession? = null,
		val trashedAt: Long? = null,
		val attachments: List<BoardStateAttachment>? = null,
		val title: ContentEnvelope,
		val body: ContentEnvelope? = null,
		val names: JsonObject? = null,
	) : BoardOp()

	@Serializable
	@SerialName("remove")
	data class Remove(
		val id: String,
	) : BoardOp()

	@Serializable
	@SerialName("set_state")
	data class SetState(
		val id: String,
		val state: String,
	) : BoardOp()

	@Serializable
	@SerialName("set_parent")
	data class SetParent(
		val id: String,
		val parent: String? = null,
		val rank: String,
	) : BoardOp()

	@Serializable
	@SerialName("set_rank")
	data class SetRank(
		val id: String,
		val rank: String,
	) : BoardOp()

	@Serializable
	@SerialName("set_attachments")
	data class SetAttachments(
		val id: String,
		val attachments: List<BoardStateAttachment>,
	) : BoardOp()

	@Serializable
	@SerialName("set_session")
	data class SetSession(
		val id: String,
		val session: BoardSession? = null,
	) : BoardOp()

	@Serializable
	@SerialName("trash")
	data class Trash(
		val id: String,
	) : BoardOp()

	@Serializable
	@SerialName("restore")
	data class Restore(
		val id: String,
	) : BoardOp()
}

@Serializable
data class BoardWrite(
	val ops: List<BoardOp>,
	val expectedRevision: Long,
)

@Serializable
data class BoardWriteResult(
	val outcome: String,
	val revision: Long,
	val entries: List<BoardStoredEntry>,
	val cascaded: List<BoardCascaded>? = null,
	val refusal: String? = null,
)

@Serializable
data class BoardReadResult(
	val revision: Long,
	val entries: List<BoardStoredEntry>,
)

@Serializable
data class BoardObservationRow(
	val identity: String,
	val pre: BoardStoredEntry? = null,
	val post: BoardStoredEntry? = null,
)

@Serializable
data class ScheduledRecord(
	val target: ScheduledTarget,
	val fireAt: Long,
	val createdAt: Long,
	val opId: String,
	val sender: ScheduledSender,
	val files: List<String>,
	val body: ContentEnvelope,
	val state: String,
	val attempts: Long,
	val version: Long,
)

@Serializable
data class ScheduleSendValue(
	@EncodeDefault
	val kind: String = "schedule_send",
	val target: ScheduledTarget,
	val fireAt: Long,
	val opId: String,
	val files: List<String>,
	val body: ContentEnvelope,
	val expectedVersion: Long? = null,
)

@Serializable
data class ScheduleCancelValue(
	@EncodeDefault
	val kind: String = "schedule_cancel",
	val target: ScheduledTarget,
	val expectedVersion: Long,
)

@Serializable
data class ScheduledResultRow(
	val opId: String,
	val outcome: String,
	val seq: Long? = null,
	val body: ContentEnvelope,
)

@Serializable
data class CapabilitiesReport(
	@EncodeDefault
	val kind: String = "capabilities_report",
	val capabilities: List<EnabledPlugin>? = null,
	val clientVersion: String? = null,
)

@Serializable
data class CapabilitySnapshot(
	val known: Boolean,
	val capabilities: List<EnabledPlugin>,
	val clientVersions: List<String>,
)

@Serializable
data class ReportRead(
	@EncodeDefault
	val kind: String = "report_read",
	val team: String,
	val epoch: Long,
	val seq: Long,
	val at: Long,
)

@Serializable
data class ReadAnchorsResult(
	val version: ReadAnchorsVersion,
	val anchors: List<ReadAnchorWireEntry>,
)

@Serializable
data class WireFrame(
	val name: String,
	val params: JsonObject,
)

@Serializable
data class WireRequest(
	val method: String,
	val path: String,
	val headers: JsonObject,
	val body: String,
)

@Serializable
data class WirePhoneDecode(
	val decodeAs: String,
	val sealed: List<WireSealed>,
)

@Serializable
data class WireSealed(
	val path: String,
	val aadKind: String,
	val decodeAs: String? = null,
	val plaintextOf: String? = null,
	val expectJson: JsonObject? = null,
)

@Serializable
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("producer")
sealed class WireFixture {
	@Serializable
	@SerialName("ts")
	data class Ts(
		val composer: String,
		val case: String,
		val clock: Long,
		val inputs: JsonObject,
		val expect: JsonObject,
		val frame: WireFrame,
		val phone: WirePhoneDecode? = null,
	) : WireFixture()

	@Serializable
	@SerialName("kotlin")
	data class Kotlin(
		val composer: String,
		val case: String,
		val clock: Long,
		val inputs: JsonObject,
		val expect: JsonObject,
		val request: WireRequest,
		val sealed: List<WireSealed>? = null,
	) : WireFixture()
}

@Serializable
data class WireFixtureEntry(
	val file: String,
	val composer: String,
	val case: String,
	val peer: String,
)

@Serializable
data class WireManifest(
	val _comment: String,
	val fixtures: List<WireFixtureEntry>,
)

@Serializable
data class RefFileMeta(
	val refPath: String,
	val segments: List<RefSegmentMeta>? = null,
	val keys: List<RefKeyMeta>,
)

@Serializable
data class RefSegmentMeta(
	val startLine: Long,
	val lineCount: Long,
)

@Serializable
data class RefKeyMeta(
	val key: String,
	val startLine: Long,
	val endLine: Long,
	val span: RefSpanMeta? = null,
	val quality: String,
	val reason: String? = null,
	val ambiguous: Boolean? = null,
	val matchCount: Long? = null,
)

@Serializable
data class RefSpanMeta(
	val startLine: Long,
	val startColumn: Long,
	val endLine: Long,
	val endColumn: Long,
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
data class DomainSnapshot(
	val ownerSignPub: String,
	val admissions: List<SignedAdmission>,
	val revocations: List<SignedRevocation>,
	val displayName: String? = null,
)

@Serializable
data class PresenceVersion(
	val gateway: String,
	val epoch: Long,
	val version: Long,
)

@Serializable
data class CrossDomainPeerEntry(
	val domainId: String,
	val gatewayId: String,
	val ownerSignPub: String,
)

@Serializable
data class LinkedPeersVersion(
	val epoch: Long,
	val version: Long,
)

@Serializable
data class ReadAnchorWireEntry(
	val team: String,
	val epoch: Long,
	val seq: Long,
	val at: Long,
)

@Serializable
data class ReadAnchorsVersion(
	val epoch: Long,
	val version: Long,
)

@Serializable
data class BoardEntry(
	val id: String,
	val title: String,
	val body: String? = null,
	val state: String,
	val parent: String? = null,
	val rank: String,
	val sessionId: String? = null,
	val session: BoardSession? = null,
	val trashedAt: Long? = null,
	val attachments: List<BoardAttachment>? = null,
)

@Serializable
data class BoardSession(
	val domainId: String,
	val gatewayId: String,
	val sessionId: String,
)

@Serializable
data class BoardAttachment(
	val blobId: String,
	val blobGateway: String,
	val filename: String,
	val mime: String,
	val size: Long,
)

@Serializable
data class TaskBoardVersion(
	val epoch: Long,
	val version: Long,
)

@Serializable
data class CrossDomainPresenceVersion(
	val epoch: Long,
	val version: Long,
)

@Serializable
data class CrossDomainPresenceSession(
	val team: String,
	val gatewayId: String,
	val status: String,
	val kind: String,
	val sessionLabel: String? = null,
	val description: String? = null,
	val lastActive: Long? = null,
	val queueDepth: Long,
	val working: Boolean? = null,
	val needsLogin: Boolean? = null,
)

@Serializable
data class CrossDomainShareEntry(
	val sessionTarget: String,
	val target: CrossDomainShareTarget,
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
data class SealedEnvelope(
	val ephemeralPub: String,
	val nonce: String,
	val ciphertext: String,
	val signature: String,
)

@Serializable
data class ConsoleApprovalJoin(
	val newSignPub: String,
	val newBoxPub: String,
	val joinSig: String? = null,
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

@Serializable
data class PresencePlane(
	val epoch: Long,
	val version: Long,
)

@Serializable
data class DiscoverCoverage(
	val rosterKnown: Boolean,
	val asked: Long,
	val answered: Long,
	val unreachable: List<String>? = null,
	val unreachablePeers: List<String>? = null,
)

@Serializable
data class GatewaySpawnPoints(
	val domainId: String? = null,
	val gatewayId: String,
	val hostSpawns: List<String>,
)

@Serializable
data class BoardEntryClear(
	val id: String,
	val state: String,
	val parent: String? = null,
	val rank: String,
	val session: BoardSession? = null,
	val trashedAt: Long? = null,
	val attachments: List<BoardStateAttachment>? = null,
	val version: Long,
)

@Serializable
data class BoardStateAttachment(
	val blobId: String,
	val size: Long,
	val mime: String,
	val blobGateway: String,
)

@Serializable
data class BoardEntrySealed(
	val title: ContentEnvelope,
	val body: ContentEnvelope? = null,
	val names: JsonObject? = null,
)

@Serializable
data class BoardCascaded(
	val id: String,
	val from: String,
	val to: String,
	val reason: String,
)

@Serializable
data class ScheduledTarget(
	val domainId: String,
	val gatewayId: String,
	val sessionId: String,
)

@Serializable
data class ScheduledSender(
	val conversationId: String,
	val device: String,
)

@Serializable
data class EnabledPlugin(
	/** The plugin's globally unique id, as its manifest declares it. */
	val id: String,
	/** Agent-facing usage guidance for this capability, surfaced to the session. */
	val instructions: String? = null,
)
