package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.WireFixture
import com.atelier_nyaarium.switchboard.proto.WireManifest
import com.atelier_nyaarium.switchboard.proto.WirePhoneDecode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WireFixturesDecodeTest {
	private val world = FixtureWorld.fromResources()

	@Test
	fun opensEverySealedValueTheGatewayDeclares() {
		val manifest = wireJson.decodeFromJsonElement<WireManifest>(load("wire/ts/_manifest.json"))
		for (entry in manifest.fixtures) {
			val file = entry.file
			val fixture = wireJson.decodeFromJsonElement<WireFixture>(load("wire/ts/$file")) as? WireFixture.Ts ?: continue
			val phone = fixture.phone ?: continue
			runCatching { check(file, fixture, phone) }.getOrElse { throw AssertionError(file, it) }
		}
	}

	private fun check(file: String, fixture: WireFixture.Ts, phone: WirePhoneDecode) {
		val params = fixture.frame.params
		decodeFrame(phone.decodeAs, params)
		val declared = phone.sealed.map { normalize(it.path) }
		for (path in envelopePaths(params, "")) assertTrue("$file undeclared sealed value at $path", path in declared)
		for (sealed in phone.sealed) {
			val envelope = wireJson.decodeFromJsonElement<ContentEnvelope>(resolve(params, sealed.path))
			val plain = open(envelope, sealed.aadKind)
			sealed.decodeAs?.let { decodePlain(it, plain) }
			sealed.plaintextOf?.let { assertEquals("$file ${sealed.path}", fixture.inputs.getValue(it).jsonPrimitive.content, plain) }
			sealed.expectJson?.let { expected ->
				val actual = wireJson.parseToJsonElement(plain).jsonObject
				for ((key, value) in expected) assertEquals("$file ${sealed.path}.$key", value, actual[key])
			}
		}
	}

	private fun decodeFrame(decodeAs: String, params: JsonObject) {
		when (decodeAs) {
			"RowEnvelope" -> wireJson.decodeFromJsonElement<RowEnvelope>(params.getValue("row").jsonObject.getValue("envelope"))
			"ContentEnvelope" -> wireJson.decodeFromJsonElement<ContentEnvelope>(params.getValue("result"))
			"BoardOp" -> wireJson.decodeFromJsonElement<BoardOp>(params.getValue("write").jsonObject.getValue("ops").jsonArray.first())
			else -> error("unsupported frame decode target $decodeAs")
		}
	}

	private fun decodePlain(decodeAs: String, plain: String) {
		when (decodeAs) {
			"ConsoleListDirsResult" -> wireJson.decodeFromString<ConsoleListDirsResult>(plain)
			"MailboxEntry" -> wireJson.decodeFromString<MailboxEntry>(plain)
			else -> error("unsupported plaintext decode target $decodeAs")
		}
	}

	private fun normalize(path: String): String = path.replace(Regex("\\[(\\d+)]"), ".$1")

	private fun resolve(root: JsonElement, path: String): JsonElement {
		var current = root
		for (part in normalize(path).split(".")) {
			current = part.toIntOrNull()?.let { current.jsonArray[it] } ?: current.jsonObject.getValue(part)
		}
		return current
	}

	private fun envelopePaths(element: JsonElement, prefix: String): List<String> = when (element) {
		is JsonObject ->
			if (element.keys.containsAll(listOf("v", "epoch", "nonce", "ciphertext"))) listOf(prefix)
			else element.flatMap { (key, child) -> envelopePaths(child, if (prefix.isEmpty()) key else "$prefix.$key") }
		is JsonArray -> element.flatMapIndexed { index, child -> envelopePaths(child, if (prefix.isEmpty()) "$index" else "$prefix.$index") }
		else -> emptyList()
	}

	private fun open(envelope: ContentEnvelope, kind: String): String =
		Crypto.openContent(
			envelope,
			world.contentKey,
			Crypto.ContentAad(world.domainId, world.ownerIdentity.sign.pub, envelope.epoch.toInt(), kind),
		).toString(Charsets.UTF_8)

	private fun load(name: String): JsonObject = javaClass.classLoader?.getResourceAsStream(name)?.bufferedReader()?.use {
		wireJson.parseToJsonElement(it.readText()).jsonObject
	} ?: error("missing fixture: $name")
}
