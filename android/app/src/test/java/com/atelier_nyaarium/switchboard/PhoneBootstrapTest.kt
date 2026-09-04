package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneBootstrapTest {
	@Test
	fun missingProvisioningIsReported() {
		val store = testStore()

		assertEquals(BootState.Missing(setOf(Need.PROVISIONING)), PhoneBootstrap.assemble(store, FederationManager(store)))
	}

	@Test
	fun missingDomainIdIsReported() {
		val store = testStore()
		testBootstrap(store = store, domainId = "domain")

		store.saveDomainId("")
		val emptyState = PhoneBootstrap.assemble(store, FederationManager(store))
		store.saveDomainId(" ")
		val blankState = PhoneBootstrap.assemble(store, FederationManager(store))

		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), emptyState)
		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), blankState)
	}

	@Test
	fun readyBootstrapSignsVerifiableOwnerOp() {
		val console = Crypto.generateIdentity()
		val store = testStore()
		val boot = testBootstrap(store = store, domainId = "domain", identity = console)
		val ambient = testAmbient(clock = 7L, nonce = "nonce", opId = "op")
		val op = OwnerOps(boot, ambient).sign(buildJsonObject {})

		assertTrue(Crypto.verify(
			ownerOpSigningBytes(
				op.domainId, op.signerSignPub, op.conversationId, op.device, op.opId, op.at, op.nonce, op.op,
			),
			op.signature,
			boot.consoleIdentity.sign.pub,
		))
		assertEquals(7L, op.at)
		assertEquals("nonce", op.nonce)
	}

	@Test
	fun keyringReadsDomainSnapshotSavedAfterAssembly() {
		val store = testStore()
		val boot = testBootstrap(store = store, domainId = "domain")
		val snapshot = DomainSnapshot(boot.ownerSignPub, emptyList(), emptyList())
		store.saveDomain(wireJson.encodeToString(DomainSnapshot.serializer(), snapshot), "test")

		assertEquals(snapshot, boot.keyring().snapshot)
	}
}
