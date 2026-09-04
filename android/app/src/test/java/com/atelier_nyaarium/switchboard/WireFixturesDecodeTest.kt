package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.BoardOp
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.InboxRow
import com.atelier_nyaarium.switchboard.proto.MailboxEntry
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
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
		val manifest = load("wire/ts/_manifest.json").getValue("fixtures").jsonArray
		val domain = root.getValue("domain").jsonObject
		val key = java.util.Base64.getDecoder().decode(root.getValue("content").jsonObject.getValue("key").jsonPrimitive.content)
		for (entry in manifest) {
			val item = entry.jsonObject
			val phone = item["phone"]?.jsonObject ?: continue
			val file = item.getValue("file").jsonPrimitive.content
			val fixture = load("wire/ts/$file")
			runCatching { decode(file, fixture, phone, key, domain.getValue("id").jsonPrimitive.content, domain.getValue("owner").jsonObject.getValue("sign").jsonObject.getValue("pub").jsonPrimitive.content) }
			.getOrElse { throw AssertionError(file, it) }
		}
	}

	private fun decode(file: String, fixture: JsonObject, phone: JsonObject, key: ByteArray, domain: String, owner: String) {
		val params = fixture.getValue("frame").jsonObject.getValue("params").jsonObject
		when (phone.getValue("decodeAs").jsonPrimitive.content) {
			"InboxRow" -> {
				val row = wireJson.decodeFromJsonElement<InboxRow>(params.getValue("row"))
				val envelope = wireJson.decodeFromJsonElement<ContentEnvelope>(row.body)
				val entry = open(envelope, key, domain, owner, phone.getValue("open").jsonObject.getValue("aadKind").jsonPrimitive.content)
				val actual = wireJson.decodeFromString<MailboxEntry>(entry)
				val expected = wireJson.decodeFromJsonElement<MailboxEntry>(fixture.getValue("inputs").jsonObject.getValue("entry"))
				assertEquals("$file kind", expected.kind, actual.kind)
				assertEquals("$file body", expected.body, actual.body)
			}
			"ContentEnvelope" -> {
				val envelope = wireJson.decodeFromJsonElement<ContentEnvelope>(params.getValue("result"))
				val opened = wireJson.decodeFromString<ConsoleListDirsResult>(open(envelope, key, domain, owner, phone.getValue("open").jsonObject.getValue("aadKind").jsonPrimitive.content))
				val expected = wireJson.decodeFromJsonElement<ConsoleListDirsResult>(fixture.getValue("inputs").jsonObject.getValue("result"))
				assertEquals("$file entries", expected.entries, opened.entries)
			}
			"BoardOp" -> {
				val op = wireJson.decodeFromJsonElement<BoardOp>(params.getValue("write").jsonObject.getValue("ops").jsonArray.first()) as BoardOp.Upsert
				val openKinds = phone.getValue("open").jsonObject
				val inputs = fixture.getValue("inputs").jsonObject
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
