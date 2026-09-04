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
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement

////////////////////////////////
//  Per-session ops
//

suspend fun ConsoleClient.respond(
	target: String,
	status: String? = null,
	response: String? = null,
	replyAsJson: JsonObject? = null,
	files: List<ChannelFile>? = null,
	opId: String = UUID.randomUUID().toString(),
): ConsoleRespondResult = deliveryResult(
	sendDeliveryOp(
		sessionAddressOf(target),
		ConsoleOp.Respond(target, status, response, replyAsJson, files),
		opId,
	),
	Protocol.Wire.ConsoleOpKind.RESPOND,
)

suspend fun ConsoleClient.wake(target: String, opId: String = UUID.randomUUID().toString()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.Wake(target), opId), Protocol.Wire.ConsoleOpKind.WAKE)
}

suspend fun ConsoleClient.reloadPlugins(gatewayId: String, opId: String = UUID.randomUUID().toString()): com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult =
	valueResult<com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult>(
		sendValueOp(gatewayId, ConsoleOp.ReloadPlugins(gatewayId), opId),
		Protocol.Wire.ConsoleOpKind.RELOAD_PLUGINS,
	)

/** Capture the target's visible tmux pane for the terminal view. Pass the last hash so the
 * Gateway returns unchanged=true (no ansi) for an idle pane. */
suspend fun ConsoleClient.peek(target: String, sinceHash: String? = null): ConsolePeekResult =
	valueResult(sendValueOp(transport.targetGatewayOf(target), ConsoleOp.Peek(target = target, sinceHash = sinceHash)), Protocol.Wire.ConsoleOpKind.PEEK)

/** Send literal text OR a named control key to the target's tmux pane. `submit` (text only, default
 * true) controls the trailing Enter: false types into the composer without submitting. Idempotent
  */
suspend fun ConsoleClient.tmuxSend(
	target: String,
	text: String? = null,
	key: String? = null,
	submit: Boolean = true,
	opId: String = UUID.randomUUID().toString(),
) {
	requireDelivery(
		sendDeliveryOp(sessionAddressOf(target), ConsoleOp.TmuxSend(target = target, text = text, key = key, submit = submit), opId),
		Protocol.Wire.ConsoleOpKind.TMUX_SEND,
	)
}

/** Forget a session: kill its tmux and drop its resume record. Idempotent per opId; the Gateway
 * rejects a bare spawn-point (a composite session is required). */
/** Returns the disposition the Gateway actually APPLIED, or null when it did not say. Null means
 * a Gateway that predates the field: it stripped the request's copy and released the session's
 * work, so a caller that asked to cancel has to be told its choice did not happen. */
suspend fun ConsoleClient.forget(
	target: String,
	boardDisposition: String? = null,
	opId: String = UUID.randomUUID().toString(),
): String? {
	val op = ConsoleOp.Forget(target = target, boardDisposition = boardDisposition)
	return deliveryResult<ConsoleForgetResult>(sendDeliveryOp(sessionAddressOf(target), op, opId), Protocol.Wire.ConsoleOpKind.FORGET).boardDisposition
}

/** Close a session: kill its tmux but KEEP its resume record (a restart / mop-up), so it stays
 * listed as available. Idempotent per opId; the Gateway rejects a bare spawn-point, refuses while
 * a wake is in flight, and reports a user-launched session rather than a false success. */
suspend fun ConsoleClient.closeSession(target: String, opId: String = UUID.randomUUID().toString()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.CloseSession(target = target), opId), Protocol.Wire.ConsoleOpKind.CLOSE_SESSION)
}

/** Spawn a new session in a spawn-point project. A `displayLabel` lets the gateway mint the id
 * (the minted id is the tmux name) and returns it; a `sessionName` is adopted as the id (the
 * old form, against a gateway that does not mint). `workdir` is a picked host working directory
 * (absolute or ~-rooted; host target only) - absent keeps the label-derived default. Idempotent
 * per opId (reattaches if it already exists). Returns the gateway's reply; `id` is absent from
 * an older gateway. */
suspend fun ConsoleClient.createSession(
	target: String,
	sessionName: String? = null,
	displayLabel: String? = null,
	workdir: String? = null,
	opId: String = UUID.randomUUID().toString(),
): ConsoleCreateSessionResult =
	valueResult(sendValueOp(transport.targetGatewayOf(target), ConsoleOp.CreateSession(target = target, sessionName = sessionName, displayLabel = displayLabel, workdir = workdir), opId), Protocol.Wire.ConsoleOpKind.CREATE_SESSION)

/** List the immediate subdirectories of one host directory (the create-session directory
 * picker's type-ahead). Read-only, fresh each call, like peek. The path must be absolute or
 * ~-rooted; an unreadable or missing one returns empty entries rather than an error.
 *
 * `hostTarget` names WHICH machine's filesystem to browse, and is the qualified host spawn point when
 * creating on another gateway. Required rather than defaulted to a bare "host": a bare target resolves
 * to the home gateway, so an omitted one lists THIS machine's filesystem and hands back a path that
 * does not exist on the one the session will run on. */
suspend fun ConsoleClient.listDirs(path: String, hostTarget: String, spawn: String): ConsoleListDirsResult =
	valueResult(sendValueOp(transport.targetGatewayOf(hostTarget), ConsoleOp.ListDirs(path = path, spawn = spawn)), Protocol.Wire.ConsoleOpKind.LIST_DIRS)

/** Rename a session: set the gateway-authoritative sessionLabel on its record. Idempotent per
 * opId. Returns the label the gateway actually applied (after its sanitize + per-spawn dedup). */
suspend fun ConsoleClient.renameSession(
	target: String,
	sessionLabel: String,
	opId: String = UUID.randomUUID().toString(),
): ConsoleRenameSessionResult =
	deliveryResult(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.RenameSession(target = target, sessionLabel = sessionLabel), opId), Protocol.Wire.ConsoleOpKind.RENAME_SESSION)

/** Idempotent per opId. */
suspend fun ConsoleClient.reportRead(
	team: String,
	anchor: ReadAnchor,
	opId: String = UUID.randomUUID().toString(),
): ConsoleReportReadResult =
	wireJson.decodeFromJsonElement(
		postSigned(composeReportRead(team, anchor, System.currentTimeMillis()), opId) ?: error("report_read timed out"),
	)
