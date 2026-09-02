package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceInstallCommitTest {
	private val owner = Crypto.generateIdentity()
	private val console = Crypto.generateIdentity()
	private val recipient = Crypto.generateIdentity()

	private fun keyring() = Keyring(
		DomainSnapshot(
			owner.sign.pub,
			listOf(
				AdmissionCrypto.signAdmission(
					Admission("console", console.sign.pub, console.box.pub, null, 1, "nonce"),
					owner.sign.priv,
					owner.sign.pub,
				),
			),
			emptyList(),
		),
	)

	private fun signedEnvelope(signer: Crypto.Identity = console) = Crypto.wrapContentKey(
		ByteArray(32) { 7 },
		1,
		recipient.box.pub,
		signer.sign.pub,
		signer.sign.priv,
	)

	@Test
	fun refusedClassificationWritesNothing() {
		val prefs = TestPreferences()
		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		val refused = ContentKeyring(recipient.box.priv, store).classify(
			listOf(signedEnvelope(owner)),
			keyring(),
		)

		assertNull(refused)
		assertFalse(prefs.contains(AppStateStore.KEY_BLOB))
		assertFalse(prefs.contains(AppStateStore.KEY_CONTENT_KEYS))
		assertFalse(prefs.contains(AppStateStore.KEY_CONSOLE_ADMITTED))
		assertFalse(prefs.contains(AppStateStore.KEY_FIRST_ROOTED))
		assertFalse(prefs.contains(AppStateStore.KEY_ENROLL_CEREMONY_DONE))
	}

	@Test
	fun acceptedInstallCommitsTheCompleteRecord() {
		val prefs = TestPreferences()
		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		val keys = ContentKeyring(recipient.box.priv, store).classify(listOf(signedEnvelope()), keyring())!!

		assertTrue(store.installApprovedDevice("blob", "domain", "version", "gateway", keys))

		assertEquals("blob", store.load())
		assertTrue(store.consoleAdmitted)
		assertTrue(store.firstRooted)
		assertTrue(store.enrollCeremonyDone)
		assertEquals("domain", store.loadDomain())
		assertEquals("version", store.loadDomainVersion())
		assertEquals("gateway", store.loadGatewayId())
		assertArrayEquals(ByteArray(32) { 7 }, (store.loadContentKeys() as ContentKeysLoad.Loaded).keys.getValue(1))
	}
}
