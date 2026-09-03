package com.atelier_nyaarium.switchboard

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

internal data class RouterStateSlot(
	val epoch: Long,
	val version: Long,
	val payload: JsonElement,
)

internal fun newerRouterState(incoming: RouterStateSlot, applied: RouterStateSlot?): Boolean =
	applied == null || incoming.epoch != applied.epoch ||
		(incoming.epoch == applied.epoch && incoming.version > applied.version)

internal fun RouterStateSlot.encode(): JsonObject = buildJsonObject {
		put("epoch", epoch)
		put("version", version)
		put("payload", payload)
}

internal fun JsonObject.decodeRouterStateSlot(): RouterStateSlot = RouterStateSlot(
	epoch = this["epoch"]?.jsonPrimitive?.long ?: 0L,
	version = this["version"]?.jsonPrimitive?.long ?: 0L,
	payload = this["payload"] ?: buildJsonObject { },
)
