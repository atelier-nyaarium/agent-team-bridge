package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot

internal fun testBootstrap(
	store: AppStateStore = testStore(),
	domainId: String = "test-domain",
	identity: Crypto.Identity = Crypto.generateIdentity(),
	owner: Crypto.Identity = Crypto.generateIdentity(),
	contentKeyring: ContentKeyring? = null,
	device: String = "test-device",
	conversationId: String = "test-conversation",
	domain: DomainSnapshot? = null,
): PhoneBootstrap {
	store.save(
		wireJson.encodeToString(
			com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
			com.atelier_nyaarium.switchboard.proto.Provisioning(
				appToken = "test-token",
				device = device,
				conversationId = conversationId,
			),
		),
	)
	store.saveIdentity(identity)
	store.saveOwnerIdentity(owner)
	store.saveDomainId(domainId)
	contentKeyring?.epochs()?.associateWith { epoch -> requireNotNull(contentKeyring.keyFor(epoch)) }?.let(store::saveContentKeys)
	domain?.let {
		store.saveDomain(wireJson.encodeToString(DomainSnapshot.serializer(), it), "test")
	}
	return (PhoneBootstrap.assemble(store, FederationManager(store)) as BootState.Ready).boot
}

internal fun testAmbient(
	clock: Long = 1L,
	nonce: String = "test-nonce",
	opId: String = "test-op",
	nonceBytes: ByteArray = ByteArray(12),
	wrapEntropy: (Int) -> ByteArray = { size -> ByteArray(size) },
	timer: MissingEpochTimer = object : MissingEpochTimer {
		override fun schedule(delayMs: Long, task: suspend () -> Unit) {}
	},
	now: () -> Long = { clock },
): PhoneAmbient = PhoneAmbient(now, { nonce }, { nonceBytes }, { opId }, wrapEntropy, timer)
