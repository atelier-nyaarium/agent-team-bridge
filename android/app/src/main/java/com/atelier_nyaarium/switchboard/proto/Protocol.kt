// generated from src/shared/schemas.ts + src/shared/phone-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
//
// Decode with Json { ignoreUnknownKeys = true } (the additive-protocol
// posture). Enum-like fields are open Strings on purpose: the phone must
// tolerate values newer than this build.
//
// ENCODE config is load-bearing: the default Json (encodeDefaults = false)
// omits null-defaulted optionals, which is exactly what the arbiter's zod
// schemas accept - zod .optional() REJECTS explicit nulls. If encodeDefaults
// is ever enabled (e.g. to emit a defaulted const like PhoneRelayFrame.type),
// it MUST pair with explicitNulls = false. Note the phone's POST body is the
// op-only envelope {device, conversationId, opId, op}; evie composes the full
// phone_relay frame, so PhoneRelayFrame is decode-side here.
@file:Suppress("unused")

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
	const val PHONE_PROTOCOL_VERSION: Int = 1

	/** Session-id prefix for broadcast notices; the sender follows it. */
	const val NOTICE_SESSION_PREFIX: String = "notice:"

	/** Session-id prefix for channel conversations; the target team is the tail after the LAST colon. */
	const val CONV_SESSION_PREFIX: String = "conv:"

	/** Separator in a host-qualified name (host then local name); the first one splits host from local name. */
	const val HOST_QUALIFIER_SEP: String = "/"
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
	val host: String? = null,
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
sealed class PhoneOp {
	@Serializable
	@SerialName("register")
	data object Register : PhoneOp()

	@Serializable
	@SerialName("list_teams")
	data object ListTeams : PhoneOp()

	@Serializable
	@SerialName("send")
	data class Send(
		val to: String,
		val request_type: String? = null,
		val effort: String? = null,
		val body: String,
		val files: List<ChannelFile>? = null,
	) : PhoneOp()

	@Serializable
	@SerialName("respond")
	data class Respond(
		val session_id: String,
		val status: String? = null,
		val response: String? = null,
		val replyAsJson: JsonObject? = null,
		val files: List<ChannelFile>? = null,
	) : PhoneOp()

	@Serializable
	@SerialName("poll")
	data class Poll(
		val cursor: Long? = null,
		val epoch: Long? = null,
		val holdMs: Long? = null,
	) : PhoneOp()
}

@Serializable
data class PhoneRelayFrame(
	val type: String = "phone_relay",
	val v: Long,
	val device: String,
	val conversationId: String,
	val opId: String,
	val op: PhoneOp,
)

@Serializable
data class PhoneRelayReply(
	val type: String = "phone_relay_reply",
	val v: Long,
	val opId: String,
	val ok: Boolean,
	val result: JsonElement? = null,
	val error: String? = null,
)

@Serializable
data class PhoneRegisterResult(
	val device: String,
	val hostId: String? = null,
	val cursor: Long,
	val epoch: Long,
)

@Serializable
data class PhoneListTeamsResult(
	val teams: List<TeamInfo>,
)

@Serializable
data class PhoneSendResult(
	val session_id: String,
	val status: String,
)

@Serializable
data class PhoneRespondResult(
	val delivered: Boolean,
)

@Serializable
data class PhonePollResult(
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
	val hostId: String? = null,
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
