package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.PendingTenantRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneIdentityTest {
	private fun blob(pendingTenant: PendingTenantRef? = null, device: String = "device"): String = wireJson.encodeToString(
		com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
		com.atelier_nyaarium.switchboard.proto.Provisioning(
			appToken = "token",
			device = device,
			conversationId = "conversation",
			pendingTenant = pendingTenant,
		),
	)

	private fun identity(store: AppStateStore = testStore()) = PhoneIdentity(store, FederationManager(store))

	private fun ready(identity: PhoneIdentity): PhoneBootstrap = identity.readyOrNull() ?: error("not ready")

	@Test
	fun provisionThenReachMovesMissingToReady() {
		val identity = identity()
		assertEquals(BootState.Missing(setOf(Need.PROVISIONING)), identity.bootState.value)

		identity.provision(blob())
		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), identity.bootState.value)

		assertTrue(identity.learnDomainId("learned", identity.blob()!!))
		assertEquals("learned", ready(identity).domainId)
	}

	@Test
	fun anInviteIsReadyForItsPendingTenantUntilTheRouterConfirms() {
		val identity = identity()

		identity.provision(blob(PendingTenantRef("tenant", "nonce")))
		assertEquals("tenant", ready(identity).domainId)

		identity.learnDomainId("confirmed", identity.blob()!!)
		assertEquals("confirmed", ready(identity).domainId)
	}

	@Test
	fun factsLearnedForAnOlderBlobAreRefused() {
		val store = testStore()
		val identity = identity(store)
		identity.provision(blob())
		val old = identity.blob()!!
		store.saveGatewayId("gw")

		identity.provision(blob(device = "replacement"))

		assertFalse(identity.learnDomainId("old", old))
		assertFalse(identity.markFirstRooted(old))
		assertEquals(BootState.Missing(setOf(Need.DOMAIN_ID)), identity.bootState.value)
		assertFalse(store.firstRooted)
		assertEquals("", store.loadGatewayId())
		assertTrue(identity.markFirstRooted(identity.blob()!!))
		assertTrue(store.firstRooted)
	}

	@Test
	fun clearingEndsMissingWithNoBootToSignWith() {
		val identity = identity()
		identity.provision(blob())
		identity.learnDomainId("learned", identity.blob()!!)

		identity.clear()

		assertEquals(BootState.Missing(setOf(Need.PROVISIONING)), identity.bootState.value)
		assertNull(identity.readyOrNull())
	}

	@Test
	fun ownerRestoreRepublishesTheOwnerKey() {
		val source = testStore()
		val backup = FederationManager(source).exportOwnerBackup("pass")
		val restoredPub = FederationManager(source).ownerSignPub()
		val identity = identity()
		identity.provision(blob())
		identity.learnDomainId("learned", identity.blob()!!)
		val before = ready(identity)

		assertEquals(OwnerRestoreResult.OK, identity.importOwnerBackup(backup, "pass"))

		val after = ready(identity)
		assertNotSame(before, after)
		assertEquals(restoredPub, after.ownerSignPub)
	}

	@Test
	fun keysBelongToTheBootsGenerationAndARepacedBootIsRefused() {
		val store = testStore()
		val identity = identity(store)
		identity.provision(blob())
		identity.learnDomainId("learned", identity.blob()!!)
		val boot = ready(identity)
		assertTrue(boot.contentKeyring.epochs().isEmpty())

		identity.ensureContentEpochs(boot)
		assertSame(boot, identity.readyOrNull())
		assertEquals(listOf(1), boot.contentKeyring.epochs())

		val owner = (store.loadOwnerIdentity() as IdentityLoad.Loaded).identity
		val console = boot.consoleIdentity
		val envelope = Crypto.wrapContentKey(
			Crypto.deriveContentKey(owner.sign.priv, "learned", 2),
			2,
			console.box.pub,
			console.sign.pub,
			console.sign.priv,
		) { size -> ByteArray(size) { 7 } }
		val admission = AdmissionCrypto.signAdmission(
			Admission("console", console.sign.pub, console.box.pub, null, 1, "console"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val trust = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission), emptyList()))
		assertTrue(identity.installContentKey(boot, envelope, trust).committed)
		assertEquals(listOf(1, 2), boot.contentKeyring.epochs())

		identity.provision(blob(device = "replacement"))
		identity.learnDomainId("learned", identity.blob()!!)
		assertFalse(identity.installContentKey(boot, envelope, trust).accepted)
		assertEquals(listOf(1, 2), boot.contentKeyring.epochs())
	}
}
