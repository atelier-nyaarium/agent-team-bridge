package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import java.util.UUID
import kotlinx.serialization.json.JsonObject

/** Signed operations identify this console. */
// Mutations use signed HTTP operations.
class OwnerOps(private val repo: ChatRepository) {

	/** No domain means no signing. */
	fun domainId(): String? = repo.confirmedDomainId()?.takeIf { it.isNotEmpty() }

	/** Sign the complete canonical operation. */
	fun sign(op: JsonObject, opId: String = UUID.randomUUID().toString()): OwnerOp? {
		val domain = domainId() ?: return null
		val identity = repo.federation.consoleIdentity()
		val prov = repo.client().transport.prov
		val at = System.currentTimeMillis()
		val nonce = UUID.randomUUID().toString()
		val signature = Crypto.sign(
			ownerOpSigningBytes(
				domainId = domain,
				signerSignPub = identity.sign.pub,
				conversationId = prov.conversationId,
				device = prov.device,
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
			conversationId = prov.conversationId,
			device = prov.device,
			opId = opId,
			at = at,
			nonce = nonce,
			op = op,
			signature = signature,
		)
	}
}
