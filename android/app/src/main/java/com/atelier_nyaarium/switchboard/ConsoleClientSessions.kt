package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleForgetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleReportReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRespondResult
import com.atelier_nyaarium.switchboard.proto.ChannelFile
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement


suspend fun ConsoleClient.respond(
	target: String,
	status: String? = null,
	response: String? = null,
	replyAsJson: JsonObject? = null,
	files: List<ChannelFile>? = null,
	opId: String = ambient.newOpId(),
): ConsoleRespondResult = deliveryResult(
	sendDeliveryOp(
		sessionAddressOf(target),
		ConsoleOp.Respond(target, status, response, replyAsJson, files),
		opId,
	),
	Protocol.Wire.ConsoleOpKind.RESPOND,
)

suspend fun ConsoleClient.wake(target: String, opId: String = ambient.newOpId()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.Wake(target), opId), Protocol.Wire.ConsoleOpKind.WAKE)
}

suspend fun ConsoleClient.reloadPlugins(gatewayId: String, opId: String = ambient.newOpId()): com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult =
	valueResult<com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult>(
		sendValueOp(gatewayId, ConsoleOp.ReloadPlugins(gatewayId), opId),
		Protocol.Wire.ConsoleOpKind.RELOAD_PLUGINS,
	)

suspend fun ConsoleClient.peek(target: String, sinceHash: String? = null): ConsolePeekResult =
	valueResult(sendValueOp(transport.targetGatewayOf(target), ConsoleOp.Peek(target = target, sinceHash = sinceHash)), Protocol.Wire.ConsoleOpKind.PEEK)

suspend fun ConsoleClient.tmuxSend(
	target: String,
	text: String? = null,
	key: String? = null,
	submit: Boolean = true,
	opId: String = ambient.newOpId(),
) {
	requireDelivery(
		sendDeliveryOp(sessionAddressOf(target), ConsoleOp.TmuxSend(target = target, text = text, key = key, submit = submit), opId),
		Protocol.Wire.ConsoleOpKind.TMUX_SEND,
	)
}

suspend fun ConsoleClient.forget(
	target: String,
	boardDisposition: String? = null,
	opId: String = ambient.newOpId(),
): String? {
	val op = ConsoleOp.Forget(target = target, boardDisposition = boardDisposition)
	return deliveryResult<ConsoleForgetResult>(sendDeliveryOp(sessionAddressOf(target), op, opId), Protocol.Wire.ConsoleOpKind.FORGET).boardDisposition
}

suspend fun ConsoleClient.closeSession(target: String, opId: String = ambient.newOpId()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.CloseSession(target = target), opId), Protocol.Wire.ConsoleOpKind.CLOSE_SESSION)
}

suspend fun ConsoleClient.createSession(
	target: String,
	sessionName: String? = null,
	displayLabel: String? = null,
	workdir: String? = null,
	opId: String = ambient.newOpId(),
): ConsoleCreateSessionResult =
	valueResult(sendValueOp(transport.targetGatewayOf(target), ConsoleOp.CreateSession(target = target, sessionName = sessionName, displayLabel = displayLabel, workdir = workdir), opId), Protocol.Wire.ConsoleOpKind.CREATE_SESSION)

// Resolve paths on the host target.
suspend fun ConsoleClient.listDirs(path: String, hostTarget: String, spawn: String): ConsoleListDirsResult =
	valueResult(sendValueOp(transport.targetGatewayOf(hostTarget), ConsoleOp.ListDirs(path = path, spawn = spawn)), Protocol.Wire.ConsoleOpKind.LIST_DIRS)

suspend fun ConsoleClient.renameSession(
	target: String,
	sessionLabel: String,
	opId: String = ambient.newOpId(),
): ConsoleRenameSessionResult =
	deliveryResult(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.RenameSession(target = target, sessionLabel = sessionLabel), opId), Protocol.Wire.ConsoleOpKind.RENAME_SESSION)

suspend fun ConsoleClient.reportRead(
	team: String,
	anchor: ReadAnchor,
	opId: String = ambient.newOpId(),
): ConsoleReportReadResult =
	wireJson.decodeFromJsonElement(
		postSigned(composeReportRead(team, anchor, System.currentTimeMillis()), opId) ?: error("report_read timed out"),
	)
