package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapBundle
import com.atelier_nyaarium.switchboard.proto.GatewayTransport
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FederationManagerContentTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun com.atelier_nyaarium.switchboard.proto.SealedEnvelope.asCrypto() =
		Crypto.SealedEnvelope(ephemeralPub, nonce, ciphertext, signature)

	@Test
	fun sealBundleCarriesGatewayAndConsoleAdmissionsAndContentKey() {
		val store = testStore()
		val owner = Crypto.generateIdentity()
		store.saveOwnerIdentity(owner)
		val manager = FederationManager(store)
		val gateway = Crypto.generateIdentity()
		val gatewayAdmission = manager.admitGateway("gw", gateway.sign.pub, gateway.box.pub, 2)

		val frame = manager.sealBundle(
			"nonce",
			GatewayTransport(routerUrl = "https://router", bearer = "token"),
			gatewayAdmission,
			gateway.box.pub,
			"domain",
		)
		val plain = Crypto.unseal(frame.sealed.asCrypto(), gateway.box.priv,manager.consoleIdentity().sign.pub)
		val bundle = json.decodeFromString(GatewayBootstrapBundle.serializer(), plain.toString(Charsets.UTF_8))
		assertEquals(2, bundle.domain.admissions.size)
		assertTrue(bundle.domain.admissions.contains(gatewayAdmission))
		assertTrue(
			bundle.domain.admissions.any { it.admission.kind == "console" && AdmissionCrypto.verifyAdmission(it, owner.sign.pub) },
		)
		assertEquals(1, bundle.contentKeys?.size)
		val keyEnvelope = bundle.contentKeys!!.single()
		val unwrapped = Crypto.unwrapContentKey(keyEnvelope, gateway.box.priv)
		assertEquals(1, unwrapped.first)
		assertArrayEquals(Crypto.deriveContentKey(owner.sign.priv, "domain", 1), unwrapped.second)
		assertTrue(
			json.encodeToString(com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame.serializer(), frame).length < 4096,
		)
	}

	@Test
	fun sealBundleWithoutOwnerKeyKeepsConsoleAdmissionAndSendsNoContentKeys() {
		val store = testStore()
		val owner = Crypto.generateIdentity()
		val console = Crypto.generateIdentity()
		store.saveIdentity(console)
		val consoleAdmission = AdmissionCrypto.signAdmission(
			Admission("console", console.sign.pub, console.box.pub, null, 1, "console"),
			owner.sign.priv,
			owner.sign.pub,
		)
		store.saveDomain(
			json.encodeToString(
				DomainSnapshot.serializer(),
				DomainSnapshot(owner.sign.pub, listOf(consoleAdmission), emptyList()),
			),
			"v1",
		)
		val gateway = Crypto.generateIdentity()
		val gatewayAdmission = AdmissionCrypto.signAdmission(
			Admission("gateway", gateway.sign.pub, gateway.box.pub, "gw", 2, "gateway"),
			owner.sign.priv,
			owner.sign.pub,
		)

		val frame = FederationManager(store).sealBundle(
			"nonce",
			GatewayTransport(bearer = "token"),
			gatewayAdmission,
			gateway.box.pub,
			"domain",
		)
		val plain = Crypto.unseal(frame.sealed.asCrypto(), gateway.box.priv, console.sign.pub)
		val bundle = json.decodeFromString(GatewayBootstrapBundle.serializer(), plain.toString(Charsets.UTF_8))
		assertEquals(setOf(consoleAdmission, gatewayAdmission), bundle.domain.admissions.toSet())
		assertTrue(bundle.contentKeys.orEmpty().isEmpty())
	}

	@Test
	fun sealBundleRefusesAConsoleAbsentFromAForeignRootedSnapshot() {
		val store = testStore()
		val foreignOwner = Crypto.generateIdentity()
		val console = Crypto.generateIdentity()
		store.saveIdentity(console)
		val gateway = Crypto.generateIdentity()
		val gatewayAdmission = AdmissionCrypto.signAdmission(
			Admission("gateway", gateway.sign.pub, gateway.box.pub, "gw", 2, "gateway"),
			foreignOwner.sign.priv,
			foreignOwner.sign.pub,
		)
		store.saveDomain(
			json.encodeToString(
				DomainSnapshot.serializer(),
				DomainSnapshot(foreignOwner.sign.pub, listOf(gatewayAdmission), emptyList()),
			),
			"v1",
		)

		assertThrows(IllegalStateException::class.java) {
			FederationManager(store).sealBundle("nonce", GatewayTransport(bearer = "token"), gatewayAdmission, gateway.box.pub, "domain")
		}
	}

	@Test
	fun ensureContentEpochsDoesNotUseAThrowawayOwnerKey() {
		val store = testStore()
		val stored = Crypto.generateIdentity()
		val root = Crypto.generateIdentity()
		store.saveOwnerIdentity(stored)
		store.saveDomain(
			json.encodeToString(DomainSnapshot.serializer(), DomainSnapshot(root.sign.pub, emptyList(), emptyList())),
			"v1",
		)

		FederationManager(store).ensureContentEpochs("domain")

		assertTrue(store.loadContentKeys() is ContentKeysLoad.Absent)
	}

	@Test
	fun ensureContentEpochsDerivesEpochOneForTheSnapshotRoot() {
		val store = testStore()
		val owner = Crypto.generateIdentity()
		store.saveOwnerIdentity(owner)
		store.saveDomain(
			json.encodeToString(DomainSnapshot.serializer(), DomainSnapshot(owner.sign.pub, emptyList(), emptyList())),
			"v1",
		)

		FederationManager(store).ensureContentEpochs("domain")

		assertArrayEquals(
			Crypto.deriveContentKey(owner.sign.priv, "domain", 1),
			(store.loadContentKeys() as ContentKeysLoad.Loaded).keys.getValue(1),
		)
	}

	@Test
	fun restoreUsesTheSnapshotRootAndLatchRules() {
		val owner = Crypto.generateIdentity()
		val foreign = Crypto.generateIdentity()
		val throwaway = Crypto.generateIdentity()
		val backupStore = testStore()
		backupStore.saveOwnerIdentity(owner)
		val backup = FederationManager(backupStore).exportOwnerBackup("pass")

		val rooted = testStore()
		rooted.saveOwnerIdentity(throwaway)
		rooted.saveDomain(
			json.encodeToString(DomainSnapshot.serializer(), DomainSnapshot(owner.sign.pub, emptyList(), emptyList())),
			"v1",
		)
		val storedBackupStore = testStore()
		storedBackupStore.saveOwnerIdentity(throwaway)
		val storedBackup = FederationManager(storedBackupStore).exportOwnerBackup("pass")
		assertEquals(OwnerRestoreResult.OK, FederationManager(rooted).importOwnerBackup(storedBackup, "pass"))
		assertEquals(throwaway.sign.pub, (rooted.loadOwnerIdentity() as IdentityLoad.Loaded).identity.sign.pub)

		val foreignStore = testStore()
		foreignStore.saveOwnerIdentity(throwaway)
		foreignStore.saveDomain(
			json.encodeToString(DomainSnapshot.serializer(), DomainSnapshot(owner.sign.pub, emptyList(), emptyList())),
			"v1",
		)
		val foreignBackupStore = testStore()
		foreignBackupStore.saveOwnerIdentity(foreign)
		val foreignBackup = FederationManager(foreignBackupStore).exportOwnerBackup("pass")
		assertEquals(
			OwnerRestoreResult.DIFFERENT_OWNER,
			FederationManager(foreignStore).importOwnerBackup(foreignBackup, "pass"),
		)
		assertEquals(throwaway.sign.pub, (foreignStore.loadOwnerIdentity() as IdentityLoad.Loaded).identity.sign.pub)

		val fresh = testStore()
		fresh.saveOwnerIdentity(throwaway)
		assertEquals(OwnerRestoreResult.OK, FederationManager(fresh).importOwnerBackup(backup, "pass"))

		val latched = testStore()
		latched.saveOwnerIdentity(owner)
		latched.firstRooted = true
		assertEquals(OwnerRestoreResult.OK, FederationManager(latched).importOwnerBackup(backup, "pass"))

		val consoleLatched = testStore()
		consoleLatched.saveOwnerIdentity(throwaway)
		consoleLatched.consoleAdmitted = true
		assertEquals(OwnerRestoreResult.DIFFERENT_OWNER, FederationManager(consoleLatched).importOwnerBackup(backup, "pass"))

		val absentLatched = testStore()
		absentLatched.firstRooted = true
		assertEquals(OwnerRestoreResult.OK, FederationManager(absentLatched).importOwnerBackup(backup, "pass"))
		assertEquals(owner.sign.pub, (absentLatched.loadOwnerIdentity() as IdentityLoad.Loaded).identity.sign.pub)
	}
}
