package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.EnabledPlugin
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun composeCapabilitiesReport(plugins: List<EnabledPlugin>): JsonObject = buildJsonObject {
	put("kind", JsonPrimitive("capabilities_report"))
	put("capabilities", wireJson.encodeToJsonElement(ListSerializer(EnabledPlugin.serializer()), plugins))
}
