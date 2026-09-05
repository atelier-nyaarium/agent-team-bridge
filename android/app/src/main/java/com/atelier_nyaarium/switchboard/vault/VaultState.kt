package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import kotlinx.serialization.Serializable

/** Held until answered or past its deadline. */
@Serializable
data class VaultPendingRequest(
	/** Its gateway segment answers the request. */
	val team: String,
	val request: VaultRequest,
	val receivedAt: Long,
	/** One more than the answered asks of this command it followed within the repeat window. */
	val attempt: Int = 1,
	/** Since the latest such answer, when there was one. */
	val sinceAnswerMs: Long? = null,
) {
	val requestId: String get() = request.requestId

	val deadlineAt: Long get() = request.deadlineAt

	val operation: String get() = request.operation

	val shape: String get() = request.shape

	val sessionTarget: String get() = request.sessionTarget

	/** The askpass helper asks with no session behind it. */
	val fromHelper: Boolean get() = request.sessionTarget.startsWith("helper.")

	val entryId: String? get() = (request as? VaultRequest.Entry)?.entryId
}

val VaultRequest.requestId: String
	get() = when (this) {
		is VaultRequest.Entry -> requestId
		is VaultRequest.Typed -> requestId
	}

val VaultRequest.deadlineAt: Long
	get() = when (this) {
		is VaultRequest.Entry -> deadlineAt
		is VaultRequest.Typed -> deadlineAt
	}

val VaultRequest.operation: String
	get() = when (this) {
		is VaultRequest.Entry -> operation
		is VaultRequest.Typed -> operation
	}

val VaultRequest.shape: String
	get() = when (this) {
		is VaultRequest.Entry -> shape
		is VaultRequest.Typed -> shape
	}

val VaultRequest.sessionTarget: String
	get() = when (this) {
		is VaultRequest.Entry -> sessionTarget
		is VaultRequest.Typed -> sessionTarget
	}

/** One run of the program asking; a second ask under it followed a rejected value. */
val VaultRequest.asker: String?
	get() = when (this) {
		is VaultRequest.Entry -> asker
		is VaultRequest.Typed -> asker
	}

/** An approval the same command may come back from. */
@Serializable
data class VaultAnswered(
	val team: String,
	val operation: String,
	val answeredAt: Long,
	val attempt: Int = 1,
	val asker: String? = null,
)

@Serializable
data class VaultBlob(
	/** The vault revision the held entries reach; 0 asks for a full list. */
	val revision: Long = 0,
	/** Sealed Router entries, tombstones included. */
	val stored: List<VaultStoredEntry> = emptyList(),
	val requests: List<VaultPendingRequest> = emptyList(),
	/** Approvals inside the repeat window, oldest first. */
	val answered: List<VaultAnswered> = emptyList(),
	val lastRouterSyncAt: Long = 0,
)

/** One entry with every field but the value opened. */
data class VaultEntryView(
	val id: String,
	val revision: Long,
	val createdBy: String,
	val createdAt: Long,
	val updatedAt: Long,
	val publicTitle: String?,
	val publicDescription: String?,
	val privateTitle: String?,
	val privateDescription: String?,
	/** Null admits every gateway. */
	val gateways: List<String>?,
	/** A sealed allowlist this phone could not open. */
	val gatewaysUnreadable: Boolean,
	val hasValue: Boolean,
) {
	val title: String get() = privateTitle ?: publicTitle ?: id

	val description: String? get() = privateDescription ?: publicDescription

	/** Searchable text, private fields included. */
	fun matches(query: String): Boolean =
		listOfNotNull(publicTitle, privateTitle, publicDescription, privateDescription)
			.any { it.contains(query, ignoreCase = true) }
}

const val VAULT_DECISION_ONCE = "once"
const val VAULT_DECISION_WINDOW = "window"
const val VAULT_DECISION_SESSION = "session"
const val VAULT_DECISION_DENY = "deny"

/** Security setting values for vault approvals. */
const val VAULT_UNLOCK_OFF = "off"
const val VAULT_UNLOCK_EVERY = "every"
const val VAULT_UNLOCK_WINDOW = "window"
const val VAULT_UNLOCK_WINDOW_MS = 30L * 60 * 1000
