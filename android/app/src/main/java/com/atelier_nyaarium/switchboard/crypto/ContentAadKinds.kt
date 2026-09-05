package com.atelier_nyaarium.switchboard.crypto

// Sole home of the AAD kind builders; twins of src/shared/content-envelope.ts, pinned by shared vectors.
const val BOARD_TITLE_KIND = "board.title"
const val BOARD_BODY_KIND = "board.body"
const val BOARD_NAME_KIND = "board.name"
const val VAULT_PUBLIC_TITLE_KIND = "vault.publicTitle"
const val VAULT_PUBLIC_DESCRIPTION_KIND = "vault.publicDescription"
const val VAULT_PRIVATE_TITLE_KIND = "vault.privateTitle"
const val VAULT_PRIVATE_DESCRIPTION_KIND = "vault.privateDescription"
const val VAULT_VALUE_KIND = "vault.value"
const val VAULT_GATEWAYS_KIND = "vault.gateways"
const val VAULT_TYPED_KIND = "vault.typed"

fun assertNewlineFree(vararg values: String) {
	check(values.none { it.contains('\n') || it.contains('\r') }) { "AAD fields must be newline-free" }
}

fun boardTextAadKind(kind: String, entryId: String, attachmentId: String? = null): String {
	assertNewlineFree(kind, entryId, *listOfNotNull(attachmentId).toTypedArray())
	return listOfNotNull(kind, entryId, attachmentId).joinToString("\n")
}

/** Binds entry id, or typed-value request id. */
fun vaultAadKind(kind: String, id: String): String {
	assertNewlineFree(kind, id)
	return "$kind\n$id"
}

fun inboxBodyAadKind(conversationId: String, opId: String): String {
	assertNewlineFree(conversationId, opId)
	return "inbox.body\n$conversationId\n$opId"
}

fun scheduledBodyAadKind(conversationId: String, opId: String): String {
	assertNewlineFree(conversationId, opId)
	return "inbox.body\n$conversationId\n$opId"
}

fun valueResultAadKind(opId: String): String {
	assertNewlineFree(opId)
	return "op.result\n$opId"
}

fun opResultAadKind(conversationId: String, opId: String): String {
	assertNewlineFree(conversationId, opId)
	return "op.result\n$conversationId\n$opId"
}

fun opPayloadAadKind(): String = "op.payload"
