package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.VAULT_GATEWAYS_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PRIVATE_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_PUBLIC_TITLE_KIND
import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.proto.VaultEntryClear
import com.atelier_nyaarium.switchboard.proto.VaultEntrySealed
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.testAmbient
import com.atelier_nyaarium.switchboard.testBootstrap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class VaultDraftTest {
	private val domainId = "domain"
	private val owner = Crypto.generateIdentity()
	private val keyring = ContentKeyring().also { it.deriveOwned(owner, domainId, 1) }
	private val ours = sealing(keyring)
	private val stranger = sealing(ContentKeyring().also { it.deriveOwned(Crypto.generateIdentity(), domainId, 1) })

	private fun sealing(ring: ContentKeyring) = VaultSealing(
		testBootstrap(domainId = domainId, owner = owner, contentKeyring = ring),
		testAmbient(nonceBytes = ByteArray(12) { 1 }),
	) {}

	private val existing = VaultStoredEntry(
		VaultEntryClear("k", 1L, false, 1L, "phone", 0L, 0L),
		VaultEntrySealed(
			publicTitle = ours.seal("Deploy key", VAULT_PUBLIC_TITLE_KIND, "k"),
			privateTitle = ours.seal("prod", VAULT_PRIVATE_TITLE_KIND, "k"),
			value = ours.seal("hunter2", VAULT_VALUE_KIND, "k"),
			gateways = ours.seal("[\"laptop\"]", VAULT_GATEWAYS_KIND, "k"),
		),
	)

	@Test
	fun aReadableEntryClearsWhatTheDraftBlanksAndKeepsAnUntouchedValue() {
		val opened = VaultManager(object : VaultStore {
			override fun loadVault() = null
			override fun saveVault(json: String) = Unit
		}).view(existing, ours)
		val sealed = sealDraft(VaultDraft(id = "k", publicTitle = "Deploy key", privateTitle = ""), "k", existing, opened, ours)!!
		assertNull(sealed.privateTitle)
		assertEquals("Deploy key", ours.open(sealed.publicTitle!!, VAULT_PUBLIC_TITLE_KIND, "k"))
		assertEquals(existing.sealed.value, sealed.value)
		assertNull(sealed.gateways)

		val cleared = sealDraft(VaultDraft(id = "k", publicTitle = "x", value = "", gateways = emptyList()), "k", existing, opened, ours)!!
		assertNull(cleared.value)
		assertEquals("[]", ours.open(cleared.gateways!!, VAULT_GATEWAYS_KIND, "k"))
	}

	@Test
	fun aPhoneWithoutTheKeyKeepsEveryFieldItCouldNotOpenAndReplacesWhatItTypes() {
		val blind = VaultManager(object : VaultStore {
			override fun loadVault() = null
			override fun saveVault(json: String) = Unit
		}).view(existing, stranger)
		val sealed = sealDraft(VaultDraft(id = "k", privateTitle = "renamed"), "k", existing, blind, stranger)!!
		assertEquals(existing.sealed.publicTitle, sealed.publicTitle)
		assertEquals(existing.sealed.value, sealed.value)
		assertEquals(existing.sealed.gateways, sealed.gateways)
		assertNotNull(sealed.privateTitle)
		assertEquals("renamed", stranger.open(sealed.privateTitle!!, VAULT_PRIVATE_TITLE_KIND, "k"))
	}
}
