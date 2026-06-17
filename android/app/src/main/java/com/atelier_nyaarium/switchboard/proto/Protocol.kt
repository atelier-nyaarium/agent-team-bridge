// generated from src/shared/schemas.ts + src/shared/console-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
//
// Decode with Json { ignoreUnknownKeys = true } (the additive-protocol
// posture). Enum-like fields are open Strings on purpose: the console must
// tolerate values newer than this build.
//
// ENCODE config is load-bearing: the default Json (encodeDefaults = false)
// omits null-defaulted optionals, which is exactly what the arbiter's zod
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

	/** Session-id prefix for broadcast notices; the sender follows it. */
	const val NOTICE_SESSION_PREFIX: String = "notice:"

	/** Session-id prefix for channel conversations; the target team is the tail after the LAST colon. */
	const val CONV_SESSION_PREFIX: String = "conv:"

	/** Separator in a switch-qualified name (switch then local name); the first one splits switch from local name. */
	const val SWITCH_QUALIFIER_SEP: String = "/"
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
	val switchId: String? = null,
	val status: String,
	val mode: String? = null,
	val kind: String? = null,
	val queue_depth: Long,
)

@Serializable
data class MailboxEntry(
	val seq: Long,
	val at: Long,
	val kind: String,
	val session_id: String,
	val from: String? = null,
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
sealed class ConsoleOp {
	@Serializable
	@SerialName("register")
	data class Register(
		val clientVersion: String? = null,
		val clientVariant: String? = null,
	) : ConsoleOp()

	@Serializable
	@SerialName("list_teams")
	data object ListTeams : ConsoleOp()

	@Serializable
	@SerialName("send")
	data class Send(
		val to: String,
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
	val switchId: String? = null,
	val cursor: Long,
	val epoch: Long,
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
	val sttsUrl: String? = null,
	val sttsKey: String? = null,
	val identity: String? = null,
	val switchId: String? = null,
	val switchSignPub: String? = null,
	val switchBoxPub: String? = null,
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
	val switchId: String? = null,
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
}

@Serializable
data class EnrollResult(
	val ok: Boolean,
	val error: String? = null,
)

@Serializable
data class SealedEnvelope(
	val ephemeralPub: String,
	val nonce: String,
	val ciphertext: String,
	val signature: String,
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
