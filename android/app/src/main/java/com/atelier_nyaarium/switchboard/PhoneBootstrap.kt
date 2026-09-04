package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring

/** The Ready identity value; `PhoneIdentity` assembles it. */
class PhoneBootstrap private constructor(
	val provisioning: Provisioning,
	val consoleIdentity: Crypto.Identity,
	val ownerSignPub: String,
	val domainId: String,
	val contentKeyring: ContentKeyring,
	private val store: AppStateStore,
) {
	val conversationId: String get() = provisioning.conversationId
	val device: String get() = provisioning.device

	fun keyring(): Keyring = Keyring.parse(store.loadDomain()) ?: Keyring.empty(ownerSignPub)

	companion object {
		/** An invite's pending tenant is the Domain until reach or roster confirm one. */
		fun assemble(store: AppStateStore, federation: FederationManager): BootState {
			val blob = store.load() ?: return BootState.Missing(setOf(Need.PROVISIONING))
			val provisioning = Provisioning.parse(blob, store)
			val domain = store.loadDomainId().ifEmpty { provisioning.pendingTenant?.domainId.orEmpty() }
			if (domain.isBlank()) return BootState.Missing(setOf(Need.DOMAIN_ID))
			return BootState.Ready(
				PhoneBootstrap(
					provisioning = provisioning,
					consoleIdentity = federation.consoleIdentity(),
					ownerSignPub = federation.ownerSignPub(),
					domainId = domain,
					contentKeyring = federation.contentKeyring(),
					store = store,
				),
			)
		}
	}
}

sealed interface BootState {
	data class Ready(val boot: PhoneBootstrap) : BootState
	data class Missing(val needs: Set<Need>) : BootState
}

enum class Need { PROVISIONING, DOMAIN_ID }
