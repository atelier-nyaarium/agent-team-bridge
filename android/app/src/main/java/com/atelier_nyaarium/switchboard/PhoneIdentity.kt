package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.KeyEnvelope
import com.atelier_nyaarium.switchboard.proto.Provisioning
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first

/** The one door for identity facts; every write re-assembles the boot. */
internal class PhoneIdentity(private val store: AppStateStore, private val federation: FederationManager) {
	private val lock = Any()
	private val _bootState = MutableStateFlow(PhoneBootstrap.assemble(store, federation))
	val bootState: StateFlow<BootState> = _bootState

	fun readyOrNull(): PhoneBootstrap? = (_bootState.value as? BootState.Ready)?.boot

	suspend fun ready(): PhoneBootstrap = (bootState.first { it is BootState.Ready } as BootState.Ready).boot

	/** The blob a fact was learned for; a later blob refuses the fact. */
	fun blob(): String? = store.load()

	/** One commit forgets the gateway, the Domain, and the admission latches. */
	fun provision(blob: String): Boolean = write {
		rememberConversationId(blob)
		store.replaceProvisioning(blob)
	}

	fun saveBlob(blob: String) = write {
		rememberConversationId(blob)
		store.save(blob)
	}

	fun learnDomainId(domainId: String, forBlob: String): Boolean = write {
		if (domainId.isEmpty() || store.load() != forBlob) return@write false
		if (domainId != store.loadDomainId()) store.saveDomainId(domainId)
		true
	}

	fun markFirstRooted(forBlob: String): Boolean = write {
		(store.load() == forBlob).also { if (it) store.firstRooted = true }
	}

	fun setConsoleAdmitted(value: Boolean, forBlob: String): Boolean = write {
		(store.load() == forBlob).also { if (it) store.consoleAdmitted = value }
	}

	fun installApproved(
		blob: String,
		domainJson: String?,
		domainVersion: String?,
		gatewayId: String?,
		contentKeys: Map<Int, ByteArray>,
		domainId: String?,
	): Boolean = write {
		rememberConversationId(blob)
		domainId?.takeIf { it.isNotEmpty() }?.let(store::saveDomainId)
		store.installApprovedDevice(blob, domainJson, domainVersion, gatewayId, contentKeys)
	}

	fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		write { federation.importOwnerBackup(blob, passphrase) }

	fun applyDomainSync(snapshot: DomainSnapshot, version: String): Boolean =
		write { federation.applyDomainSync(snapshot, version) }

	fun mergeAdmission(signed: SignedAdmission) = write { federation.mergeAdmission(signed) }

	fun mergeRevocation(signed: SignedRevocation) = write { federation.mergeRevocation(signed) }

	/** The boot's keyring is the key authority of its generation; a replaced boot is refused. */
	fun ensureContentEpochs(boot: PhoneBootstrap) = synchronized(lock) {
		if (readyOrNull() === boot) federation.ensureContentEpochs(boot.domainId, boot.contentKeyring)
	}

	fun installContentKey(boot: PhoneBootstrap, envelope: KeyEnvelope, trust: Keyring): KeyDeliveryInstall = synchronized(lock) {
		if (readyOrNull() !== boot) return KeyDeliveryInstall(false, false, "boot replaced")
		val ring = boot.contentKeyring
		when (val merge = ring.classify(listOf(envelope), trust)) {
			is ContentKeyring.Merge.Refused -> KeyDeliveryInstall(false, false, merge.reason)
			ContentKeyring.Merge.Unchanged -> KeyDeliveryInstall(true, true)
			is ContentKeyring.Merge.Installed ->
				if (ring.commit(merge)) KeyDeliveryInstall(true, true) else KeyDeliveryInstall(false, false, "content key commit failed")
		}
	}

	fun clear() = write { store.clearProvisioning() }

	/** Resolved against the blob still on disk, so it must run before the new one lands. */
	private fun rememberConversationId(blob: String) {
		val wire = runCatching { wireJson.decodeFromString<Provisioning>(blob) }.getOrNull() ?: return
		store.saveConversationId(ConsoleCredentials.conversationIdFor(wire, store))
	}

	private fun <T> write(block: () -> T): T = synchronized(lock) {
		val result = block()
		_bootState.value = PhoneBootstrap.assemble(store, federation)
		result
	}
}
