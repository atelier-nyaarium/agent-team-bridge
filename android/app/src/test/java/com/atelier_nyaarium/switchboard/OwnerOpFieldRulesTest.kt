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
		val ownerOps = OwnerOps(
			confirmedDomainId = { fields.getJSONObject("domainId").getString("valid") },
			consoleIdentity = { identity },
			provisioningConversationId = { fields.getJSONObject("conversationId").getString("valid") },
			provisioningDevice = { fields.getJSONObject("device").getString("valid") },
			now = { 1L },
			newNonce = { randomNonceB64() },
			newOpId = { "field-rules-op" },
		)
		repeat(300) {
			val ownerOp = ownerOps.sign(buildJsonObject { put("kind", "representative") })
				?: error("OwnerOps.sign returned null")
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
	fun deviceSlashViolatesItsFixtureRule() {
		val fields = fixture().getJSONObject("fields")
		val identity = Crypto.generateIdentity()
		val ownerOp = OwnerOps(
			confirmedDomainId = { fields.getJSONObject("domainId").getString("valid") },
			consoleIdentity = { identity },
			provisioningConversationId = { fields.getJSONObject("conversationId").getString("valid") },
			provisioningDevice = { fields.getJSONObject("device").getString("violation") },
			now = { 1L },
			newNonce = { randomNonceB64() },
			newOpId = { "device-violation-op" },
		).sign(buildJsonObject { put("kind", "representative") }) ?: error("OwnerOps.sign returned null")
		assertFalse(matches(fields.getJSONObject("device"), ownerOp.device))
	}

	@Test
	fun blobConversationIdViolationBreaksItsFixtureRule() {
		val fields = fixture().getJSONObject("fields")
		val identity = Crypto.generateIdentity()
		val ownerOp = OwnerOps(
			confirmedDomainId = { fields.getJSONObject("domainId").getString("valid") },
			consoleIdentity = { identity },
			provisioningConversationId = { fields.getJSONObject("conversationId").getString("violation") },
			provisioningDevice = { fields.getJSONObject("device").getString("valid") },
			now = { 1L },
			newNonce = { randomNonceB64() },
			newOpId = { "conversation-violation-op" },
		).sign(buildJsonObject { put("kind", "representative") }) ?: error("OwnerOps.sign returned null")
		assertFalse(matches(fields.getJSONObject("conversationId"), ownerOp.conversationId))
	}
}
