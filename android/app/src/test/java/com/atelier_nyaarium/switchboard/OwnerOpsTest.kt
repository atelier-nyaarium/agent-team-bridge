package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.ownerOpSigningBytes
import com.atelier_nyaarium.switchboard.proto.OwnerOp
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerOpsTest {
	@Test
	fun fixedHelloSignatureVerifies() {
		val json = javaClass.classLoader?.getResourceAsStream("wire/kotlin/OwnerOps.sign/hello.json")?.bufferedReader()?.use {
			wireJson.parseToJsonElement(it.readText()).jsonObject
		} ?: error("missing hello fixture")
		val request = wireJson.parseToJsonElement(json.getValue("request").jsonObject.getValue("body").jsonPrimitive.content).jsonObject
		val ownerOp = wireJson.decodeFromJsonElement<OwnerOp>(request.getValue("ownerOp"))
		val identityRoot = javaClass.classLoader?.getResourceAsStream("identity/set.json")?.bufferedReader()?.use {
			val root = wireJson.parseToJsonElement(it.readText()).jsonObject
			root
		} ?: error("missing identity set")
		val identity = wireJson.decodeFromJsonElement<Crypto.Identity>(identityRoot.getValue("console").jsonObject.getValue("identity"))
		val inputs = json.getValue("inputs").jsonObject
		val op = inputs.getValue("op").jsonObject
		val domain = identityRoot.getValue("domain").jsonObject.getValue("id").jsonPrimitive.content
		val boot = testBootstrap(
			domainId = domain,
			identity = identity,
			device = identityRoot.getValue("console").jsonObject.getValue("device").jsonPrimitive.content,
			conversationId = identityRoot.getValue("console").jsonObject.getValue("conversationId").jsonPrimitive.content,
		)
		val ambient = testAmbient(json.getValue("clock").jsonPrimitive.long, inputs.getValue("nonce").jsonPrimitive.content, inputs.getValue("opId").jsonPrimitive.content)
		val reproduced = OwnerOps(boot, ambient).sign(op)
		assertEquals(ownerOp.signature, reproduced.signature)
		assertTrue(Crypto.verify(ownerOpSigningBytes(
			ownerOp.domainId, ownerOp.signerSignPub, ownerOp.conversationId, ownerOp.device,
			ownerOp.opId, ownerOp.at, ownerOp.nonce, ownerOp.op,
		), ownerOp.signature, identity.sign.pub))
	}
}
