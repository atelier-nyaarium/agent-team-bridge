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
import kotlinx.serialization.json.JsonObject
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

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
	"respond",
)

suspend fun ConsoleClient.wake(target: String, opId: String = UUID.randomUUID().toString()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.Wake(target), opId), "wake")
}

suspend fun ConsoleClient.reloadPlugins(gatewayId: String, opId: String = UUID.randomUUID().toString()): com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult =
	valueResult<com.atelier_nyaarium.switchboard.proto.ConsoleReloadPluginsResult>(
		sendValueOp(gatewayId, ConsoleOp.ReloadPlugins(gatewayId), opId),
		"reload_plugins",
	)

/** Capture the target's visible tmux pane for the terminal view. Pass the last hash so the
 * Gateway returns unchanged=true (no ansi) for an idle pane. */
suspend fun ConsoleClient.peek(target: String, sinceHash: String? = null): ConsolePeekResult =
	deliveryResult(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.Peek(target = target, sinceHash = sinceHash)), "peek")

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
		"tmux_send",
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
	return deliveryResult<ConsoleForgetResult>(sendDeliveryOp(sessionAddressOf(target), op, opId), "forget").boardDisposition
}

/** Close a session: kill its tmux but KEEP its resume record (a restart / mop-up), so it stays
 * listed as available. Idempotent per opId; the Gateway rejects a bare spawn-point, refuses while
 * a wake is in flight, and reports a user-launched session rather than a false success. */
suspend fun ConsoleClient.closeSession(target: String, opId: String = UUID.randomUUID().toString()) {
	requireDelivery(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.CloseSession(target = target), opId), "close")
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
	valueResult(sendValueOp(transport.targetGatewayOf(target), ConsoleOp.CreateSession(target = target, sessionName = sessionName, displayLabel = displayLabel, workdir = workdir), opId), "create_session")

/** List the immediate subdirectories of one host directory (the create-session directory
 * picker's type-ahead). Read-only, fresh each call, like peek. The path must be absolute or
 * ~-rooted; an unreadable or missing one returns empty entries rather than an error.
 *
 * `hostTarget` names WHICH machine's filesystem to browse, and is the qualified host spawn point when
 * creating on another gateway. Required rather than defaulted to a bare "host": a bare target resolves
 * to the home gateway, so an omitted one lists THIS machine's filesystem and hands back a path that
 * does not exist on the one the session will run on. */
suspend fun ConsoleClient.listDirs(path: String, hostTarget: String, spawn: String): ConsoleListDirsResult =
	valueResult(sendValueOp(transport.targetGatewayOf(hostTarget), ConsoleOp.ListDirs(path = path, spawn = spawn)), "list_dirs")

/** Rename a session: set the gateway-authoritative sessionLabel on its record. Idempotent per
 * opId. Returns the label the gateway actually applied (after its sanitize + per-spawn dedup). */
suspend fun ConsoleClient.renameSession(
	target: String,
	sessionLabel: String,
	opId: String = UUID.randomUUID().toString(),
): ConsoleRenameSessionResult =
	deliveryResult(sendDeliveryOp(sessionAddressOf(target), ConsoleOp.RenameSession(target = target, sessionLabel = sessionLabel), opId), "rename_session")

/** Report this device's read position for a team, for the cross-device read-anchor sync plane
 * (monotonic per owner - see readAnchors.ts). No targetGateway override: this is owned by the
 * console's own mailbox, so it defaults to the home Gateway.
 * Idempotent per opId (a retry re-applies the same merge, which is a no-op if it already landed). */
suspend fun ConsoleClient.reportRead(
	team: String,
	epoch: Long,
	seq: Long,
	opId: String = UUID.randomUUID().toString(),
): ConsoleReportReadResult =
	wireJson.decodeFromJsonElement(
		postSigned(
			wireJson.encodeToJsonElement(
				com.atelier_nyaarium.switchboard.proto.ReportRead.serializer(),
				com.atelier_nyaarium.switchboard.proto.ReportRead(team = team, epoch = epoch, seq = seq, at = System.currentTimeMillis()),
			).jsonObject,
			opId,
		) ?: error("report_read timed out"),
	)
