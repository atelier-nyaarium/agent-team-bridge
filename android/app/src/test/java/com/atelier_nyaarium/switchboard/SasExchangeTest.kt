package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnrollParty
import com.atelier_nyaarium.switchboard.proto.EnrollReveal
import com.atelier_nyaarium.switchboard.proto.SasCrypto
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Drives the shared commit-reveal engine both federation flows run, against a fake broker. These are
 * the checks an untrusted broker cannot influence, and until the engine existed they could only be
 * reached on a device with two phones.
 */
class SasExchangeTest {
	private val me = EnrollParty(ownerSignPub = "meSign", ownerBoxPub = "meBox", domainId = "mine")
	private val peer = EnrollParty(ownerSignPub = "peerSign", ownerBoxPub = "peerBox", domainId = "theirs")
	private val pin = "pin-xyz"
	private val salt = "mySalt"
	private val peerSalt = "peerSalt"

	/** A broker that answers with the peer's honest frames, or whatever the test substitutes. */
	private class FakeBroker(
		private val peerCommitment: String,
		private val peerReveal: EnrollReveal,
		private val silentRounds: Int = 0,
	) : SasTransport {
		var commits = 0
		var reveals = 0
		lateinit var sentReveal: EnrollReveal

		override suspend fun commit(commitment: String): String? {
			commits++
			return if (commits <= silentRounds) null else peerCommitment
		}

		override suspend fun reveal(myReveal: EnrollReveal): EnrollReveal? {
			reveals++
			sentReveal = myReveal
			return peerReveal
		}
	}

	private fun honestPeer(party: EnrollParty = peer, role: String = EnrollCeremony.ENROLLEE) =
		FakeBroker(
			peerCommitment = SasCrypto.enrollCommitment(party, role, peerSalt),
			peerReveal = EnrollReveal(party.ownerSignPub, party.ownerBoxPub, party.domainId, peerSalt),
		)

	private fun run(broker: SasTransport, authenticatePeer: (EnrollParty) -> String? = { null }) = runBlocking {
		runSasExchange(me, EnrollCeremony.ADMIN, pin, salt, broker, authenticatePeer)
	}

	@Test
	fun anHonestExchangeYieldsTheCodeBothPhonesSee() {
		val broker = honestPeer()
		val exchange = run(broker)

		assertEquals(SasCrypto.enrollSas(me, peer, pin), exchange.sas)
		assertEquals("theirs", exchange.peerDomainId)
		assertEquals(peer, exchange.peerParty)
		// The reveal carries this side's own salt, which is what binds it to the commitment sent.
		assertEquals(salt, broker.sentReveal.salt)
	}

	@Test
	fun aSilentPeerIsPolledUntilItAnswers() {
		val broker = FakeBroker(
			peerCommitment = SasCrypto.enrollCommitment(peer, EnrollCeremony.ENROLLEE, peerSalt),
			peerReveal = EnrollReveal(peer.ownerSignPub, peer.ownerBoxPub, peer.domainId, peerSalt),
			silentRounds = 2,
		)
		run(broker)
		assertEquals(3, broker.commits)
	}

	@Test
	fun aRevealThatDoesNotOpenItsCommitmentAborts() {
		// The broker swapped a key into the reveal after the peer committed to another.
		val tampered = peer.copy(ownerBoxPub = "attackerBox")
		val broker = FakeBroker(
			peerCommitment = SasCrypto.enrollCommitment(peer, EnrollCeremony.ENROLLEE, peerSalt),
			peerReveal = EnrollReveal(tampered.ownerSignPub, tampered.ownerBoxPub, tampered.domainId, peerSalt),
		)
		val message = runCatching { run(broker) }.exceptionOrNull()?.message ?: fail("tamper reached the compare")
		assertTrue("$message", "$message".contains("did not match its commitment"))
	}

	@Test
	fun aCommitmentUnderTheWrongRoleAborts() {
		// Role is part of the preimage, so a peer committing under MY role cannot open its reveal.
		val broker = honestPeer(role = EnrollCeremony.ADMIN)
		val message = runCatching { run(broker) }.exceptionOrNull()?.message ?: fail("role swap reached the compare")
		assertTrue("$message", "$message".contains("did not match its commitment"))
	}

	@Test
	fun anUnauthenticatedPeerNeverReachesTheCompare() {
		// The commit-reveal binding holds (a consistent peer), but it is the wrong person: the
		// flow's own out-of-band binding is the only thing that catches this.
		val stranger = EnrollParty("strangerSign", "strangerBox", "elsewhere")
		val broker = honestPeer(party = stranger)
		val message = runCatching {
			run(broker) { p -> if (p.ownerSignPub != peer.ownerSignPub) "not the person you asked for" else null }
		}.exceptionOrNull()?.message
		assertEquals("not the person you asked for", message)
	}

	@Test
	fun bothSidesOfOneExchangeDeriveTheSameCode() {
		// My leg as ADMIN against the peer, and the peer's own leg as ENROLLEE against me.
		val mine = run(honestPeer())
		val theirs = runBlocking {
			runSasExchange(
				peer,
				EnrollCeremony.ENROLLEE,
				pin,
				peerSalt,
				FakeBroker(
					peerCommitment = SasCrypto.enrollCommitment(me, EnrollCeremony.ADMIN, salt),
					peerReveal = EnrollReveal(me.ownerSignPub, me.ownerBoxPub, me.domainId, salt),
				),
			) { null }
		}
		assertEquals(mine.sas, theirs.sas)
	}
}
