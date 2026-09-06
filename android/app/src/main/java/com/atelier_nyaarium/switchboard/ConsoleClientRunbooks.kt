package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookFireResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPutResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Runbooks are held per gateway, so every call names the one it means.

/** The wire carries values as an object; callers hand over a map. */
private fun valuesOf(values: Map<String, String>): JsonObject =
	JsonObject(values.mapValues { (_, value) -> JsonPrimitive(value) })

suspend fun ConsoleClient.runbookList(gatewayId: String): ConsoleRunbookListResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.RunbookList), Protocol.Wire.ConsoleOpKind.RUNBOOK_LIST)

suspend fun ConsoleClient.runbookPut(gatewayId: String, runbook: Runbook): ConsoleRunbookPutResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.RunbookPut(runbook = runbook)), Protocol.Wire.ConsoleOpKind.RUNBOOK_PUT)

suspend fun ConsoleClient.runbookDelete(gatewayId: String, runbookId: String): ConsoleRunbookDeleteResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RunbookDelete(runbookId = runbookId)),
		Protocol.Wire.ConsoleOpKind.RUNBOOK_DELETE,
	)

/** The gateway renders, so what this answers is what a fire would send. */
suspend fun ConsoleClient.runbookPreview(
	gatewayId: String,
	runbookId: String,
	values: Map<String, String>,
): ConsoleRunbookPreviewResult = valueResult(
	sendValueOp(gatewayId, ConsoleOp.RunbookPreview(runbookId = runbookId, values = valuesOf(values))),
	Protocol.Wire.ConsoleOpKind.RUNBOOK_PREVIEW,
)

suspend fun ConsoleClient.runbookFire(
	gatewayId: String,
	runbookId: String,
	values: Map<String, String>,
	into: RunbookFireTarget,
	expectedRevision: Long?,
): ConsoleRunbookFireResult = valueResult(
	sendValueOp(
		gatewayId,
		ConsoleOp.RunbookFire(
			runbookId = runbookId,
			values = valuesOf(values),
			into = into,
			expectedRevision = expectedRevision,
		),
	),
	Protocol.Wire.ConsoleOpKind.RUNBOOK_FIRE,
)
