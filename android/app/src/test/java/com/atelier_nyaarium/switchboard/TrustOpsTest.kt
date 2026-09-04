package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.valueResultAadKind
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustOpsTest {
	private val world = FixtureWorld.fromResources()

	private fun sealedAnswer(op: OwnerOp, result: String): JsonElement {
		val aad = Crypto.ContentAad(world.domainId, world.ownerIdentity.sign.pub, 1, valueResultAadKind(op.opId))
		val envelope = Crypto.sealContent(result.toByteArray(Charsets.UTF_8), world.contentKey, aad)
		return buildJsonObject {
			put("outcome", "accepted")
			put("result", wireJson.encodeToJsonElement(ContentEnvelope.serializer(), envelope))
		}
	}

	@Test
	fun receiverConfirmsWithThePolledPinUntilTrustStateClears() = runBlocking {
		val answers = ArrayDeque(
			listOf(
				"""{"pairingArrived":true,"pin":"pin","sas":"123456","friendOwnerSignPub":"friend-owner","friendGatewaySignPub":"fs","friendGatewayBoxPub":"fb","friendDomainId":"friend-domain","friendGatewayId":"friend-gw"}""",
				"""{"ok":true}""",
			),
		)
		val client = world.client(FixtureDraws.forCase("TrustOps", "receiver"), sender = { op -> sealedAnswer(op, answers.removeFirst()) })
		val store = testStore().also { it.saveOwnerIdentity(world.ownerIdentity) }
		val ops = TrustOps(
			MutableStateFlow(ChatState()),
			object : ClientPort {
				override fun client() = client
				override fun transport(): ConsoleRouterTransport = error("unused")
			},
			TestIdentityPort(store, world.bootstrap()),
			IdlePresencePort,
			{ world.gatewayId },
			object : TrustOpsCollaborators {
				override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String) = dstDomainId == "friend-domain"
				override suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String) = true
			},
		)

		val friend = ops.crossDomainListenState("token").getOrThrow() ?: error("pairing did not arrive")
		val confirmed = ops.crossDomainConfirmReceiver("token", friend, "link-nonce").getOrThrow()
		ops.clearInMemory()
		val afterClear = ops.crossDomainConfirmReceiver("token", friend, "link-nonce")

		assertEquals("friend-domain", friend.friendDomainId)
		assertEquals(ConfirmOutcome.Linked, confirmed)
		assertTrue(ops.isOwnerTrusted("friend-owner"))
		assertTrue(afterClear.isFailure)
		assertTrue(answers.isEmpty())
	}
}
