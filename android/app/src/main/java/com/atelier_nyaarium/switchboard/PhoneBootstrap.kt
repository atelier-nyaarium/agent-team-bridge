package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring

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
		fun assemble(store: AppStateStore, federation: FederationManager, domainId: String?): BootState {
			val blob = store.load() ?: return BootState.Missing(setOf(Need.PROVISIONING))
			val domain = domainId?.takeIf { it.isNotBlank() } ?: return BootState.Missing(setOf(Need.DOMAIN_ID))
			return BootState.Ready(
				PhoneBootstrap(
					provisioning = Provisioning.parse(blob, store),
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
