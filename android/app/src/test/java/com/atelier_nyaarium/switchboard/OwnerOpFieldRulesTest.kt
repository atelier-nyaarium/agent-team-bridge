package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.randomNonceB64
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerOpFieldRulesTest {
	private fun fixture(): JSONObject =
		javaClass.classLoader?.getResourceAsStream("owner-op/field-rules.json")?.bufferedReader()?.use {
			JSONObject(it.readText())
		} ?: error("missing owner-op field rules fixture")

	private fun matches(rule: JSONObject, value: String): Boolean =
		Regex(rule.getString("pattern")).matches(value) &&
		(!rule.has("maxLength") || value.length <= rule.getInt("maxLength"))

	private fun assertField(fields: JSONObject, name: String, value: String) {
		assertTrue(name, matches(fields.getJSONObject(name), value))
	}

	@Test
	fun productionMintingPathsSatisfyTheirFixtureRules() {
		val fields = fixture().getJSONObject("fields")
		val nonceRule = fields.getJSONObject("nonce")
		repeat(300) {
			assertTrue("nonce", matches(nonceRule, randomNonceB64()))
		}

		val identity = Crypto.generateIdentity()
		val domain = fields.getJSONObject("domainId").getString("valid")
		val boot = testBootstrap(
			domainId = domain,
			identity = identity,
			device = fields.getJSONObject("device").getString("valid"),
			conversationId = fields.getJSONObject("conversationId").getString("valid"),
		)
		val ownerOps = OwnerOps(boot, testAmbient(clock = 1L, nonce = randomNonceB64(), opId = "field-rules-op"))
		repeat(300) {
			val ownerOp = ownerOps.sign(buildJsonObject { put("kind", "representative") })
			assertField(fields, "domainId", ownerOp.domainId)
			assertField(fields, "signerSignPub", ownerOp.signerSignPub)
			assertField(fields, "conversationId", ownerOp.conversationId)
			assertField(fields, "device", ownerOp.device)
			assertField(fields, "opId", ownerOp.opId)
			assertField(fields, "nonce", ownerOp.nonce)
			assertField(fields, "signature", ownerOp.signature)
		}
	}

	@Test
	fun aProvisionedDeviceWithASlashIsSanitizedBeforeItIsSigned() {
		val fields = fixture().getJSONObject("fields")
		val identity = Crypto.generateIdentity()
		val boot = testBootstrap(
			domainId = fields.getJSONObject("domainId").getString("valid"),
			identity = identity,
			device = fields.getJSONObject("device").getString("violation"),
			conversationId = fields.getJSONObject("conversationId").getString("valid"),
		)
		val ownerOp = OwnerOps(boot, testAmbient(clock = 1L, nonce = randomNonceB64(), opId = "device-violation-op"))
			.sign(buildJsonObject { put("kind", "representative") })
		assertTrue(matches(fields.getJSONObject("device"), ownerOp.device))
	}

	@Test
	fun blobConversationIdViolationBreaksItsFixtureRule() {
		val fields = fixture().getJSONObject("fields")
		val identity = Crypto.generateIdentity()
		val boot = testBootstrap(
			domainId = fields.getJSONObject("domainId").getString("valid"),
			identity = identity,
			device = fields.getJSONObject("device").getString("valid"),
			conversationId = fields.getJSONObject("conversationId").getString("violation"),
		)
		val ownerOp = OwnerOps(boot, testAmbient(clock = 1L, nonce = randomNonceB64(), opId = "conversation-violation-op"))
			.sign(buildJsonObject { put("kind", "representative") })
		assertFalse(matches(fields.getJSONObject("conversationId"), ownerOp.conversationId))
	}
}
