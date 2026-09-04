package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.RowEnvelope
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.WireFixture
import com.atelier_nyaarium.switchboard.proto.WireManifest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class WireFixturesDecodeTest {
	@Test
	fun decodesDeclaredPhoneFixtures() {
		val root = load("identity/set.json")
		val manifest = wireJson.decodeFromJsonElement<WireManifest>(load("wire/ts/_manifest.json"))
		val domain = root.getValue("domain").jsonObject
		val key = java.util.Base64.getDecoder().decode(root.getValue("content").jsonObject.getValue("key").jsonPrimitive.content)
		for (entry in manifest.fixtures) {
			val file = entry.file
			val fixture = wireJson.decodeFromJsonElement<WireFixture>(load("wire/ts/$file"))
			if (fixture !is WireFixture.Ts || fixture.phone == null) continue
			runCatching { decode(file, fixture, key, domain.getValue("id").jsonPrimitive.content, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content) }
			.getOrElse { throw AssertionError(file, it) }
		}
	}

	private fun decode(file: String, fixture: WireFixture.Ts, key: ByteArray, domain: String, owner: String) {
		val params = fixture.frame.params
		val phone = fixture.phone ?: error("missing phone decode")
		when (phone.decodeAs) {
			// Router stamps seq, acceptedAt, size.
			"RowEnvelope" -> {
				val row = params.getValue("row").jsonObject
				wireJson.decodeFromJsonElement<RowEnvelope>(row.getValue("envelope"))
				val envelope = wireJson.decodeFromJsonElement<ContentEnvelope>(row.getValue("body"))
				val entry = open(envelope, key, domain, owner, phone.open?.jsonObject?.getValue("aadKind")?.jsonPrimitive?.content ?: error("missing aad kind"))
				val actual = wireJson.decodeFromString<MailboxEntry>(entry)
				val expected = fixture.inputs.getValue("entry").jsonObject
				assertEquals("$file kind", expected.getValue("kind").jsonPrimitive.content, actual.kind)
				assertEquals("$file body", expected["body"]?.jsonPrimitive?.content, actual.body)
			}
			"ContentEnvelope" -> {
				val envelope = wireJson.decodeFromJsonElement<ContentEnvelope>(params.getValue("result"))
				val opened = wireJson.decodeFromString<ConsoleListDirsResult>(open(envelope, key, domain, owner, phone.open?.jsonObject?.getValue("aadKind")?.jsonPrimitive?.content ?: error("missing aad kind")))
				val expected = wireJson.decodeFromJsonElement<ConsoleListDirsResult>(fixture.inputs.getValue("result"))
				assertEquals("$file entries", expected.entries, opened.entries)
			}
			"BoardOp" -> {
				val op = wireJson.decodeFromJsonElement<BoardOp>(params.getValue("write").jsonObject.getValue("ops").jsonArray.first()) as BoardOp.Upsert
				val openKinds = phone.open?.jsonObject ?: error("missing open kinds")
				val inputs = fixture.inputs
				assertEquals("$file title", inputs.getValue("title").jsonPrimitive.content, open(op.title, key, domain, owner, openKinds.getValue("title").jsonPrimitive.content))
				assertEquals("$file body", inputs.getValue("body").jsonPrimitive.content, open(op.body!!, key, domain, owner, openKinds.getValue("body").jsonPrimitive.content))
			}
			else -> error("$file: unsupported phone decode target")
		}
	}

	private fun open(envelope: ContentEnvelope, key: ByteArray, domain: String, owner: String, kind: String): String =
		Crypto.openContent(envelope, key, Crypto.ContentAad(domain, owner, envelope.epoch.toInt(), kind)).toString(Charsets.UTF_8)

	private fun load(name: String): JsonObject = javaClass.classLoader?.getResourceAsStream(name)?.bufferedReader()?.use {
		wireJson.parseToJsonElement(it.readText()).jsonObject
	} ?: error("missing fixture: $name")
}
