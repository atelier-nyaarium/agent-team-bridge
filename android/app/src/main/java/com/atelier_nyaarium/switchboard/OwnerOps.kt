package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.serialization.json.JsonObject

/** Signed operations identify this console. */
// Mutations use signed HTTP operations.
class OwnerOps(
	private val confirmedDomainId: () -> String?,
	private val consoleIdentity: () -> Crypto.Identity,
	private val provisioningConversationId: () -> String,
	private val provisioningDevice: () -> String,
	private val now: () -> Long,
	private val newNonce: () -> String,
	private val newOpId: () -> String,
) {

	/** No domain means no signing. */
	fun domainId(): String? = confirmedDomainId()?.takeIf { it.isNotEmpty() }

	/** Sign the complete canonical operation. */
	fun sign(op: JsonObject, opId: String = newOpId()): OwnerOp? {
		val domain = domainId() ?: return null
		val identity = consoleIdentity()
		val conversation = provisioningConversationId()
		val device = provisioningDevice()
		val at = now()
		val nonce = newNonce()
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
