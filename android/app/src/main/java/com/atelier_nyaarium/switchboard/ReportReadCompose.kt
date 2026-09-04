package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ReportRead
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

fun composeReportRead(team: String, anchor: ReadAnchor, at: Long): JsonObject =
	wireJson.encodeToJsonElement(
		ReportRead.serializer(),
		ReportRead(team = team, epoch = anchor.epoch, seq = anchor.seq, at = at),
	).jsonObject
