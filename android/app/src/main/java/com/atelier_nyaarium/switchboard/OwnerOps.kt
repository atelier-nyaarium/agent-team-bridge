package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import java.util.UUID
import kotlinx.serialization.json.JsonObject

/**
 * The phone's one way to speak to the Router in its own name.
 *
 * Every op the Router accepts from a console is an OwnerOp: the Router resolves the signer to an
 * admitted console, checks the clock skew, and refuses a nonce it has seen. Nothing else the phone
 * sends carries an identity the Router can check on its own, which is why the socket's first frame
 * is one of these and why a mutation stays an HTTP POST rather than riding the socket.
 */
class OwnerOps(private val repo: ChatRepository) {

	/** Absent means this device has not rooted a Domain yet, so it can sign nothing for one. */
	fun domainId(): String? = repo.confirmedDomainId()?.takeIf { it.isNotEmpty() }

	/**
	 * Signs [op] as this console. [op] is the whole operation body including its `kind`, and its
	 * canonical hash is what the signature commits to, so a Router that re-canonicalizes reaches the
	 * same bytes.
	 */
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
