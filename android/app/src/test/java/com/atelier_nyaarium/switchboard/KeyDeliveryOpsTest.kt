package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.Keyring
import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.KeyGrant
import com.atelier_nyaarium.switchboard.proto.KeyReceipt
import com.atelier_nyaarium.switchboard.proto.KeyRequest
import com.atelier_nyaarium.switchboard.proto.KeyRequestOp
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import com.atelier_nyaarium.switchboard.proto.Revocation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyDeliveryOpsTest {
	private val owner = Crypto.generateIdentity()
	private val console = Crypto.generateIdentity()
	private val member = Crypto.generateIdentity()
	private val domain = "domain"

	private fun admission(id: Crypto.Identity, kind: String, at: Long) = AdmissionCrypto.signAdmission(
		Admission(kind, id.sign.pub, id.box.pub, if (kind == "gateway") "gateway" else null, at, "nonce-$at"),
		owner.sign.priv,
		owner.sign.pub,
	)

	private fun keyring(vararg admissions: com.atelier_nyaarium.switchboard.proto.SignedAdmission) =
		Keyring(DomainSnapshot(owner.sign.pub, admissions.toList(), emptyList()))

	private fun ownerOp(op: JsonObject) = OwnerOp(1, domain, console.sign.pub, "conversation", "device", "op", 1, "nonce", op, "signature")

	private fun request(signatureOwner: Crypto.Identity = member, signature: String? = null) = KeyRequest(
		1,
		domain,
		member.sign.pub,
		listOf(1, 2, 3),
		10,
		"request-nonce",
		signature ?: Crypto.sign(Crypto.keyRequestSigningBytes(domain, member.sign.pub, listOf(1, 2, 3), 10, "request-nonce"), signatureOwner.sign.priv),
	)

	@Test
	fun admittedRequestGetsHeldEpochsOnly() = runBlocking {
		val ring = ContentKeyring().also { it.deriveOwned(owner, domain, 2) }
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
		)

		ops.onKeyRequest(request())

		assertEquals(listOf("key_grant", "key_grant"), sent.map { it["kind"].toString().trim('"') })
		assertEquals(listOf(1L, 2L), sent.map { wireJson.decodeFromJsonElement(KeyGrant.serializer(), it["grant"]!!).envelope.epoch })
	}

	@Test
	fun badRequestAndUnadmittedRequestSendNothing() = runBlocking {
		val ring = ContentKeyring().also { it.deriveOwned(owner, domain, 1) }
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
		)
		ops.onKeyRequest(request(signature = "bad"))
		ops.onKeyRequest(request(signatureOwner = console))
		assertTrue(sent.isEmpty())
	}

	@Test
	fun emptyKeyringAndOtherRecipientSendNothing() = runBlocking {
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ContentKeyring() },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
		)
		ops.onKeyRequest(request())
		ops.onKeyGrant(KeyGrant(1, member.sign.pub, Crypto.wrapContentKey(ByteArray(32), 1, console.box.pub, member.sign.pub, member.sign.priv), 1))
		assertTrue(sent.isEmpty())
	}

	@Test
	fun grantSendsReceiptAfterCommit() = runBlocking {
		val envelope = Crypto.wrapContentKey(ByteArray(32) { 4 }, 1, console.box.pub, member.sign.pub, member.sign.priv)
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ContentKeyring(console.box.priv) },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
			install = { _, _ -> KeyDeliveryInstall(true, true) },
		)

		ops.onKeyGrant(KeyGrant(1, console.sign.pub, envelope, 20))

		assertEquals("key_receipt", sent.single()["kind"].toString().trim('"'))
		assertEquals(1L, wireJson.decodeFromJsonElement(KeyReceipt.serializer(), sent.single()["receipt"]!!).epoch)
	}

	@Test
	fun failedCommitSendsNoReceipt() = runBlocking {
		val sent = mutableListOf<JsonObject>()
		val envelope = Crypto.wrapContentKey(ByteArray(32), 1, console.box.pub, member.sign.pub, member.sign.priv)
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ContentKeyring(console.box.priv) },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
			install = { _, _ -> KeyDeliveryInstall(true, false) },
		)

		ops.onKeyGrant(KeyGrant(1, console.sign.pub, envelope, 1))

		assertTrue(sent.isEmpty())
	}

	@Test
	fun redeliveryReadsEveryMemberEpoch() = runBlocking {
		val ring = ContentKeyring().also { it.deriveOwned(owner, domain, 2) }
		val first = admission(member, "console", 1)
		val second = admission(Crypto.generateIdentity(), "gateway", 2)
		val sent = mutableListOf<JsonObject>()
		val result = buildJsonObject { put("receipts", "[]") }
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(first, second) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op ->
				sent += op.op
				if (op.op["kind"]?.toString()?.trim('"') == "key_receipts_read") buildJsonObject { put("ok", true); put("result", result) } else null
			},
		)

		val summary = ops.redeliverAll()

		assertEquals(4, sent.count { it["kind"]?.toString()?.trim('"') == "key_grant" })
		assertEquals(1, sent.count { it["kind"]?.toString()?.trim('"') == "key_receipts_read" })
		assertEquals(4, summary.size)
	}

	@Test
	fun revokedRequesterGetsNoGrant() = runBlocking {
		val revoked = AdmissionCrypto.signRevocation(Revocation(member.sign.pub, 2, "revoke"), owner.sign.priv, owner.sign.pub)
		val ring = ContentKeyring().also { it.deriveOwned(owner, domain, 1) }
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ Keyring(DomainSnapshot(owner.sign.pub, listOf(admission(member, "console", 1)), listOf(revoked))) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
		)

		ops.onKeyRequest(request())

		assertTrue(sent.isEmpty())
	}

	@Test
	fun outOfRangeRequestEpochsAreIgnored() = runBlocking {
		val ring = ContentKeyring().also { it.deriveOwned(owner, domain, 1) }
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ keyring(admission(member, "console", 1)) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
		)
		val epochs = listOf(0L, 1L, Int.MAX_VALUE.toLong() + 1)
		val at = 10L
		val nonce = "request-nonce"
		val valid = KeyRequest(1, domain, member.sign.pub, epochs, at, nonce, Crypto.sign(Crypto.keyRequestSigningBytes(domain, member.sign.pub, epochs, at, nonce), member.sign.priv))

		ops.onKeyRequest(valid)

		assertEquals(listOf(1L), sent.map { wireJson.decodeFromJsonElement(KeyGrant.serializer(), it["grant"]!!).envelope.epoch })
	}

	@Test
	fun missingEpochsRetryCoalesceAndExpire() = runBlocking {
		val timer = FakeMissingTimer()
		val ring = ContentKeyring()
		val sent = mutableListOf<JsonObject>()
		val errors = mutableListOf<String>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ Keyring.empty(console.sign.pub) },
			{ ring },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
			now = { timer.now },
			missingTimer = timer,
			reportError = { errors += it },
		)

		ops.requestMissing(1)
		ops.requestMissing(2)
		timer.runDue()
		assertEquals(1, sent.size)
		assertEquals(listOf(1L, 2L), wireJson.decodeFromJsonElement(KeyRequestOp.serializer(), sent.single()).request.epochs)
		timer.advance(10 * 60 * 1000L)
		assertEquals(2, sent.size)
		timer.advance(24 * 60 * 60 * 1000L)
		assertEquals(2, errors.size)
		assertTrue(errors.all { it.contains("epoch 1") || it.contains("epoch 2") })
	}

	@Test
	fun installedEpochCancelsMissingRetry() = runBlocking {
		val timer = FakeMissingTimer()
		val sent = mutableListOf<JsonObject>()
		val ops = KeyDeliveryOps(
			{ domain },
			{ Keyring.empty(console.sign.pub) },
			{ ContentKeyring() },
			{ console },
			{ op -> ownerOp(op) },
			{ op -> sent += op.op; null },
			now = { timer.now },
			missingTimer = timer,
			install = { _, _ -> KeyDeliveryInstall(true, true) },
		)
		ops.requestMissing(1)
		timer.runDue()
		ops.onKeyGrant(KeyGrant(1, console.sign.pub, Crypto.wrapContentKey(ByteArray(32), 1, console.box.pub, console.sign.pub, console.sign.priv), 1))
		timer.advance(10 * 60 * 1000L)

		// Receipt ends polling.
		assertEquals(1, sent.count { it["kind"]?.jsonPrimitive?.content == "key_request" })
	}

	private class FakeMissingTimer : MissingEpochTimer {
		private data class Task(val at: Long, val block: suspend () -> Unit)
		private val tasks = mutableListOf<Task>()
		var now = 0L

		override fun schedule(delayMs: Long, task: suspend () -> Unit) {
			tasks += Task(now + delayMs, task)
		}

		fun runDue() {
			val due = tasks.filter { it.at <= now }.sortedBy { it.at }
			tasks.removeAll(due.toSet())
			due.forEach { runBlocking { it.block() } }
		}

		fun advance(ms: Long) {
			now += ms
			while (tasks.any { it.at <= now }) runDue()
		}
	}
}
