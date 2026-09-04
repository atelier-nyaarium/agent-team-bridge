package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import java.util.UUID
import kotlinx.serialization.json.JsonObject

/** Signed operations identify this console. */
// Mutations use signed HTTP operations.
class OwnerOps(
	private val repo: ChatRepository?,
	private val confirmedDomainId: () -> String? = { requireNotNull(repo).confirmedDomainId() },
	private val consoleIdentity: () -> Crypto.Identity = { requireNotNull(repo).federation.consoleIdentity() },
	private val provisioningConversationId: () -> String = { requireNotNull(repo).client().transport.prov.conversationId },
	private val provisioningDevice: () -> String = { requireNotNull(repo).client().transport.prov.device },
) {

	/** No domain means no signing. */
	fun domainId(): String? = confirmedDomainId()?.takeIf { it.isNotEmpty() }

	/** Sign the complete canonical operation. */
	fun sign(op: JsonObject, opId: String = UUID.randomUUID().toString()): OwnerOp? {
		val domain = domainId() ?: return null
		val identity = consoleIdentity()
		val conversation = provisioningConversationId()
		val device = provisioningDevice()
		val at = System.currentTimeMillis()
		val nonce = com.atelier_nyaarium.switchboard.crypto.randomNonceB64()
		val signature = Crypto.sign(
			ownerOpSigningBytes(
				domainId = domain,
				signerSignPub = identity.sign.pub,
				conversationId = conversation,
				device = device,
				opId = opId,
				at = at,
				nonce = nonce,
				opJson = op,
			),
			identity.sign.priv,
		)
		return OwnerOp(
			v = 1L,
			domainId = domain,
			signerSignPub = identity.sign.pub,
			conversationId = conversation,
			device = device,
			opId = opId,
			at = at,
			nonce = nonce,
			op = op,
			signature = signature,
		)
	}
}
