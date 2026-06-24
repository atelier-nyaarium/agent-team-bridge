package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.XDomainLink
import com.atelier_nyaarium.switchboard.proto.XDomainLinkEdge
import com.atelier_nyaarium.switchboard.proto.XDomainLinkRevocation
import com.atelier_nyaarium.switchboard.proto.XDomainUntrust
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin cross-Domain link-edge / revocation signing against switchboard's
 * node:crypto, through the same vectors the vitest suite reads
 * (tests/fixtures/xdomain-link/vectors.json). If the canonical encoding or the signature
 * scheme diverges, the node-signed edge/revocation below stops verifying here - which
 * would silently break the cross-Domain relay gate. Mirrors AdmissionTest.
 */
class XDomainLinkTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("xdomain-link/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun edge(o: JsonObject) =
		XDomainLinkEdge(
			srcDomainId = o["srcDomainId"]!!.jsonPrimitive.content,
			dstDomainId = o["dstDomainId"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	private fun revocation(o: JsonObject) =
		XDomainLinkRevocation(
			srcDomainId = o["srcDomainId"]!!.jsonPrimitive.content,
			dstDomainId = o["dstDomainId"]!!.jsonPrimitive.content,
			revokedAt = o["revokedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	private fun link(o: JsonObject) =
		XDomainLink(
			myOwnerSignPub = o["myOwnerSignPub"]!!.jsonPrimitive.content,
			peerOwnerSignPub = o["peerOwnerSignPub"]!!.jsonPrimitive.content,
			peerDomainId = o["peerDomainId"]!!.jsonPrimitive.content,
			peerGatewayId = o["peerGatewayId"]!!.jsonPrimitive.content,
			peerSignPub = o["peerSignPub"]!!.jsonPrimitive.content,
			peerBoxPub = o["peerBoxPub"]!!.jsonPrimitive.content,
			issuedAt = o["issuedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	@Test
	fun edgeCanonicalBytesMatchNode() {
		val v = vectors()
		val ownerSignPub = v["ownerSignPub"]!!.jsonPrimitive.content
		val edgeVec = v["edge"]!!.jsonObject
		val bytes = XDomainLinkCrypto.edgeSigningBytes(edge(edgeVec["value"]!!.jsonObject), ownerSignPub)
		assertEquals(edgeVec["signingBytes"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
		assertEquals(edgeVec["signingBytesHex"]!!.jsonPrimitive.content, bytes.joinToString("") { "%02x".format(it) })
	}

	@Test
	fun revocationCanonicalBytesMatchNode() {
		val v = vectors()
		val ownerSignPub = v["ownerSignPub"]!!.jsonPrimitive.content
		val revVec = v["revocation"]!!.jsonObject
		val bytes = XDomainLinkCrypto.revocationSigningBytes(revocation(revVec["value"]!!.jsonObject), ownerSignPub)
		assertEquals(revVec["signingBytes"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
		assertEquals(revVec["signingBytesHex"]!!.jsonPrimitive.content, bytes.joinToString("") { "%02x".format(it) })
	}

	@Test
	fun verifiesANodeSignedEdgeAndRevocation() {
		val v = vectors()
		val ownerSignPub = v["ownerSignPub"]!!.jsonPrimitive.content
		val edgeVec = v["edge"]!!.jsonObject
		val edgeBytes = XDomainLinkCrypto.edgeSigningBytes(edge(edgeVec["value"]!!.jsonObject), ownerSignPub)
		assertTrue(Crypto.verify(edgeBytes, edgeVec["signature"]!!.jsonPrimitive.content, ownerSignPub))

		val revVec = v["revocation"]!!.jsonObject
		val revBytes = XDomainLinkCrypto.revocationSigningBytes(revocation(revVec["value"]!!.jsonObject), ownerSignPub)
		assertTrue(Crypto.verify(revBytes, revVec["signature"]!!.jsonPrimitive.content, ownerSignPub))

		// A different owner key must not verify either signature.
		val other = Crypto.generateIdentity()
		assertFalse(Crypto.verify(edgeBytes, edgeVec["signature"]!!.jsonPrimitive.content, other.sign.pub))
		assertFalse(Crypto.verify(revBytes, revVec["signature"]!!.jsonPrimitive.content, other.sign.pub))
	}

	@Test
	fun signsAndVerifiesLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()

		val e = XDomainLinkEdge("home", "bob", 5000L, "ZQ==")
		val signedEdge = XDomainLinkCrypto.signEdge(e, owner.sign.priv, owner.sign.pub)
		assertTrue(XDomainLinkCrypto.verifyEdge(signedEdge, owner.sign.pub))
		// The claimed owner key must match the expected root.
		assertFalse(XDomainLinkCrypto.verifyEdge(signedEdge, attacker.sign.pub))
		// A tampered edge (swapped dstDomainId) must not verify.
		assertFalse(XDomainLinkCrypto.verifyEdge(signedEdge.copy(edge = e.copy(dstDomainId = "carol")), owner.sign.pub))

		val r = XDomainLinkRevocation("home", "bob", 6000L, "cg==")
		val signedRev = XDomainLinkCrypto.signRevocation(r, owner.sign.priv, owner.sign.pub)
		assertTrue(XDomainLinkCrypto.verifyRevocation(signedRev, owner.sign.pub))
		assertFalse(XDomainLinkCrypto.verifyRevocation(signedRev, attacker.sign.pub))

		// The distinct prefixes mean an edge signature does not verify as a revocation over the
		// same fields (and the reverse), so neither can be replayed as the other.
		val crossRev = XDomainLinkRevocation(e.srcDomainId, e.dstDomainId, e.issuedAt, e.nonce)
		assertFalse(Crypto.verify(XDomainLinkCrypto.revocationSigningBytes(crossRev, owner.sign.pub), signedEdge.signature, owner.sign.pub))
	}

	@Test
	fun linkCanonicalBytesMatchNode() {
		val v = vectors()
		val linkVec = v["link"]!!.jsonObject
		val bytes = XDomainLinkCrypto.linkSigningBytes(link(linkVec["value"]!!.jsonObject))
		assertEquals(linkVec["signingBytes"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
		assertEquals(linkVec["signingBytesHex"]!!.jsonPrimitive.content, bytes.joinToString("") { "%02x".format(it) })
	}

	@Test
	fun verifiesANodeSignedLink() {
		val v = vectors()
		val ownerSignPub = v["ownerSignPub"]!!.jsonPrimitive.content
		val linkVec = v["link"]!!.jsonObject
		val bytes = XDomainLinkCrypto.linkSigningBytes(link(linkVec["value"]!!.jsonObject))
		assertTrue(Crypto.verify(bytes, linkVec["signature"]!!.jsonPrimitive.content, ownerSignPub))
		// A different owner key must not verify the node-signed link.
		assertFalse(Crypto.verify(bytes, linkVec["signature"]!!.jsonPrimitive.content, Crypto.generateIdentity().sign.pub))
	}

	private fun untrust(o: JsonObject) =
		XDomainUntrust(
			myOwnerSignPub = o["myOwnerSignPub"]!!.jsonPrimitive.content,
			peerOwnerSignPub = o["peerOwnerSignPub"]!!.jsonPrimitive.content,
			revokedAt = o["revokedAt"]!!.jsonPrimitive.content.toLong(),
			nonce = o["nonce"]!!.jsonPrimitive.content,
		)

	@Test
	fun untrustCanonicalBytesMatchNode() {
		val v = vectors()
		val uVec = v["untrust"]!!.jsonObject
		val bytes = XDomainLinkCrypto.untrustSigningBytes(untrust(uVec["value"]!!.jsonObject))
		assertEquals(uVec["signingBytes"]!!.jsonPrimitive.content, bytes.toString(Charsets.UTF_8))
		assertEquals(uVec["signingBytesHex"]!!.jsonPrimitive.content, bytes.joinToString("") { "%02x".format(it) })
	}

	@Test
	fun verifiesANodeSignedUntrust() {
		val v = vectors()
		val ownerSignPub = v["ownerSignPub"]!!.jsonPrimitive.content
		val uVec = v["untrust"]!!.jsonObject
		val bytes = XDomainLinkCrypto.untrustSigningBytes(untrust(uVec["value"]!!.jsonObject))
		assertTrue(Crypto.verify(bytes, uVec["signature"]!!.jsonPrimitive.content, ownerSignPub))
		assertFalse(Crypto.verify(bytes, uVec["signature"]!!.jsonPrimitive.content, Crypto.generateIdentity().sign.pub))
	}

	@Test
	fun signsAndVerifiesUntrustLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()
		val u = XDomainUntrust(
			myOwnerSignPub = owner.sign.pub,
			peerOwnerSignPub = attacker.sign.pub,
			revokedAt = 8000L,
			nonce = "dQ==",
		)
		val signed = XDomainLinkCrypto.signUntrust(u, owner.sign.priv, owner.sign.pub)
		assertTrue(XDomainLinkCrypto.verifyUntrust(signed, owner.sign.pub))
		assertFalse(XDomainLinkCrypto.verifyUntrust(signed, attacker.sign.pub))
		// A tampered peerOwnerSignPub (would untrust a different person) must not verify.
		assertFalse(XDomainLinkCrypto.verifyUntrust(signed.copy(untrust = u.copy(peerOwnerSignPub = "AAAA")), owner.sign.pub))
	}

	@Test
	fun signsAndVerifiesLinkLocally() {
		val owner = Crypto.generateIdentity()
		val attacker = Crypto.generateIdentity()
		val l = XDomainLink(
			myOwnerSignPub = owner.sign.pub,
			peerOwnerSignPub = attacker.sign.pub,
			peerDomainId = "bob",
			peerGatewayId = "bob-desktop",
			peerSignPub = "cGVlci1zaWdu",
			peerBoxPub = "cGVlci1ib3g=",
			issuedAt = 7000L,
			nonce = "bA==",
		)
		val signed = XDomainLinkCrypto.signLink(l, owner.sign.priv, owner.sign.pub)
		assertTrue(XDomainLinkCrypto.verifyLink(signed, owner.sign.pub))
		assertFalse(XDomainLinkCrypto.verifyLink(signed, attacker.sign.pub))
		// A tampered link (swapped peerGatewayId) must not verify.
		assertFalse(XDomainLinkCrypto.verifyLink(signed.copy(link = l.copy(peerGatewayId = "evil")), owner.sign.pub))
	}
}
