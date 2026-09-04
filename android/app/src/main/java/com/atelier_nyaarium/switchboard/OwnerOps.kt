package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.serialization.json.JsonObject

internal class OwnerOps(
	private val boot: PhoneBootstrap,
	private val ambient: PhoneAmbient,
) {
	fun domainId(): String = boot.domainId

	fun sign(op: JsonObject, opId: String = ambient.newOpId()): OwnerOp {
		val domain = boot.domainId
		val identity = boot.consoleIdentity
		val conversation = boot.conversationId
		val device = boot.device
		val at = ambient.now()
		val nonce = ambient.newNonce()
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
