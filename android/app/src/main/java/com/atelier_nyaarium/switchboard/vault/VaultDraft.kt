package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.crypto.VAULT_GATEWAYS_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_DESCRIPTION_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.VaultEntrySealed
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray

/** What the editor hands over; a null value keeps the sealed one, an empty one clears it. */
data class VaultDraft(
	val id: String? = null,
	val publicTitle: String = "",
	val publicDescription: String = "",
	val privateTitle: String = "",
	val privateDescription: String = "",
	val value: String? = null,
	/** Null admits every gateway, or keeps a scope this phone cannot open. */
	val gateways: List<String>? = null,
)

sealed interface VaultSaveOutcome {
	data class Applied(val id: String) : VaultSaveOutcome

	/** The Router's copy moved since the editor opened. */
	data object Conflict : VaultSaveOutcome

	data class Refused(val reason: String) : VaultSaveOutcome

	data object Unreachable : VaultSaveOutcome
}

/**
 * The sealed fields a draft becomes. A blank field this phone could not open keeps its envelope;
 * a blank one it could open is cleared. Null when a seal fails for want of a key.
 */
fun sealDraft(
	draft: VaultDraft,
	id: String,
	existing: VaultStoredEntry?,
	opened: VaultEntryView?,
	sealing: VaultSealing,
): VaultEntrySealed? {
	fun field(text: String, kind: String, held: ContentEnvelope?, readable: Boolean): ContentEnvelope? {
		val trimmed = text.trim()
		if (trimmed.isEmpty()) return if (held != null && !readable) held else null
		return sealing.seal(trimmed, kind, id)
	}
	val value = when {
		draft.value == null -> existing?.sealed?.value
		draft.value.isEmpty() -> null
		else -> sealing.seal(draft.value, VAULT_VALUE_KIND, id) ?: return null
	}
	val gateways = when {
		draft.gateways != null -> {
			val text = buildJsonArray { draft.gateways.forEach { add(it) } }.toString()
			sealing.seal(text, VAULT_GATEWAYS_KIND, id) ?: return null
		}
		opened?.gatewaysUnreadable == true -> existing?.sealed?.gateways
		else -> null
	}
	return VaultEntrySealed(
		publicTitle = field(draft.publicTitle, VAULT_PUBLIC_TITLE_KIND, existing?.sealed?.publicTitle, opened?.publicTitle != null),
		publicDescription = field(
			draft.publicDescription,
			VAULT_PUBLIC_DESCRIPTION_KIND,
			existing?.sealed?.publicDescription,
			opened?.publicDescription != null,
		),
		privateTitle = field(draft.privateTitle, VAULT_PRIVATE_TITLE_KIND, existing?.sealed?.privateTitle, opened?.privateTitle != null),
		privateDescription = field(
			draft.privateDescription,
			VAULT_PRIVATE_DESCRIPTION_KIND,
			existing?.sealed?.privateDescription,
			opened?.privateDescription != null,
		),
		value = value,
		gateways = gateways,
	)
}
