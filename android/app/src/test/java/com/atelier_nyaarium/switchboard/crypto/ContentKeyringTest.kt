package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.ContentKeysLoad
import com.atelier_nyaarium.switchboard.TestPreferences
import com.atelier_nyaarium.switchboard.testStore
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentKeyringTest {
	private val owner = Crypto.generateIdentity()
	private val console = Crypto.generateIdentity()
	private val recipient = Crypto.generateIdentity()

	private fun admission(kind: String, id: Crypto.Identity, issuedAt: Long) =
		AdmissionCrypto.signAdmission(
			Admission(kind, id.sign.pub, id.box.pub, if (kind == "gateway") "gw" else null, issuedAt, "n-$issuedAt"),
			owner.sign.priv,
			owner.sign.pub,
		)

	@Test
	fun installClassifiesConsoleGatewayAndReAdmittedSigners() {
		val envelope = Crypto.wrapContentKey(ByteArray(32) { 7 }, 1, recipient.box.pub, console.sign.pub, console.sign.priv)
		val consoleKeyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission("console", console, 1)), emptyList()))
		val keyring = ContentKeyring(recipient.box.priv)

		assertEquals(ContentKeyring.InstallOutcome.Installed, keyring.install(envelope, consoleKeyring))
		assertEquals(ContentKeyring.InstallOutcome.AlreadyPresent, keyring.install(envelope, consoleKeyring))

		val gatewayKeyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission("gateway", console, 2)), emptyList()))
		assertEquals(
			ContentKeyring.InstallOutcome.Refused,
			ContentKeyring(recipient.box.priv).install(envelope, gatewayKeyring),
		)
	}

	@Test
	fun newerGatewayAdmissionWinsOverOlderConsoleAdmission() {
		val envelope = Crypto.wrapContentKey(ByteArray(32) { 9 }, 1, recipient.box.pub, console.sign.pub, console.sign.priv)
		val snapshot = DomainSnapshot(
			owner.sign.pub,
			listOf(admission("console", console, 1), admission("gateway", console, 2)),
			emptyList(),
		)
		assertEquals(
			ContentKeyring.InstallOutcome.Refused,
			ContentKeyring(recipient.box.priv).install(envelope, Keyring(snapshot)),
		)
	}

	@Test
	fun wrapAllForDeliversEveryOwnedEpoch() {
		val sender = ContentKeyring()
		sender.deriveOwned(owner, "domain", 2)
		val envelopes = sender.wrapAllFor(recipient.box.pub, console.sign.pub, console.sign.priv)
		val receiver = ContentKeyring(recipient.box.priv)
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission("console", console, 1)), emptyList()))

		envelopes.forEach { assertEquals(ContentKeyring.InstallOutcome.Installed, receiver.install(it, keyring)) }
		assertEquals(listOf(1, 2), receiver.epochs())
		assertArrayEquals(Crypto.deriveContentKey(owner.sign.priv, "domain", 1), receiver.keyFor(1))
		assertArrayEquals(Crypto.deriveContentKey(owner.sign.priv, "domain", 2), receiver.keyFor(2))
	}

	@Test
	fun ownerMismatchIsPreservedAndRebuilt() {
		val prefs = TestPreferences()
		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		store.saveContentKeys(mapOf(1 to ByteArray(32) { 1 }, 2 to ByteArray(32) { 2 }))
		val ring = ContentKeyring(store = store)
		ring.ensureOwnerEpochs(owner, "domain")
		// Verification stops at epoch 1.
		assertEquals(listOf(1), ring.epochs())
		assertArrayEquals(Crypto.deriveContentKey(owner.sign.priv, "domain", 1), ring.keyFor(1))
		assertTrue(prefs.getString(AppStateStore.KEY_CONTENT_KEYS_CORRUPT, null) != null)
		assertTrue(store.loadContentKeys() is ContentKeysLoad.Loaded)
	}

	@Test
	fun corruptSlotIsPreservedAndEpochOneIsDerived() {
		val prefs = TestPreferences()
		val raw = "{ not json"
		prefs.edit().putString(AppStateStore.KEY_CONTENT_KEYS, raw).apply()
		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		val ring = ContentKeyring(store = store)

		ring.ensureOwnerEpochs(owner, "domain")

		assertEquals(raw, prefs.getString(AppStateStore.KEY_CONTENT_KEYS_CORRUPT, null))
		assertArrayEquals(Crypto.deriveContentKey(owner.sign.priv, "domain", 1), ring.keyFor(1))
	}

	@Test
	fun mismatchRebuildStopsAtHighestVerifiedEpoch() {
		val store = testStore()
		store.saveContentKeys(
			mapOf(
				1 to Crypto.deriveContentKey(owner.sign.priv, "domain", 1),
				2 to Crypto.deriveContentKey(owner.sign.priv, "domain", 2),
				99 to ByteArray(32) { 3 },
			),
		)

		val ring = ContentKeyring(store = store)
		ring.ensureOwnerEpochs(owner, "domain")

		assertEquals(listOf(1, 2), ring.epochs())
	}

	@Test
	fun classifyIsAtomicAndAcceptsOnlyEqualHeldBytes() {
		val store = testStore()
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission("console", console, 1)), emptyList()))
		val valid = Crypto.wrapContentKey(ByteArray(32) { 7 }, 1, recipient.box.pub, console.sign.pub, console.sign.priv)
		val refused = Crypto.wrapContentKey(ByteArray(32) { 8 }, 2, recipient.box.pub, owner.sign.pub, owner.sign.priv)
		val content = ContentKeyring(recipient.box.priv, store)
		assertEquals(null, content.classify(listOf(valid, refused), keyring))
		assertEquals(ContentKeysLoad.Absent, store.loadContentKeys())

		val merged = content.classify(listOf(valid, valid), keyring)!!
		assertArrayEquals(ByteArray(32) { 7 }, merged.getValue(1))
		content.commit(merged)
		val mismatch = Crypto.wrapContentKey(ByteArray(32) { 9 }, 1, recipient.box.pub, console.sign.pub, console.sign.priv)
		assertEquals(null, content.classify(listOf(mismatch), keyring))

		val otherRecipient = Crypto.generateIdentity()
		val wrongRecipient = Crypto.wrapContentKey(
			ByteArray(32) { 10 },
			2,
			otherRecipient.box.pub,
			console.sign.pub,
			console.sign.priv,
		)
		assertEquals(null, content.classify(listOf(wrongRecipient), keyring))
	}

	@Test
	fun nonRootOperationsRefuseCorruptStorage() {
		val prefs = TestPreferences()
		prefs.edit().putString(AppStateStore.KEY_CONTENT_KEYS, "{ not json").apply()
		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)
		val content = ContentKeyring(recipient.box.priv, store)
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admission("console", console, 1)), emptyList()))
		val envelope = Crypto.wrapContentKey(ByteArray(32), 1, recipient.box.pub, console.sign.pub, console.sign.priv)
		assertThrows(IllegalStateException::class.java) { content.install(envelope, keyring) }
		assertThrows(IllegalStateException::class.java) {
			content.wrapAllFor(recipient.box.pub, console.sign.pub, console.sign.priv)
		}
	}
}
