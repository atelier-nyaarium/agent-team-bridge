package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleCreateSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleForgetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleListDirsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRenameSessionResult
import com.atelier_nyaarium.switchboard.proto.ConsoleReportReadResult
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement

////////////////////////////////
//  Per-session ops
//
//  Each seals to the Gateway that homes its subject, so work on another machine is reached E2E rather
//  than through this device's route Gateway. reportRead is the exception and says why.

/** Capture the target's visible tmux pane for the terminal view. Pass the last hash so the
 * Gateway returns unchanged=true (no ansi) for an idle pane. */
suspend fun ConsoleClient.peek(target: String, sinceHash: String? = null): ConsolePeekResult =
	transport.resultOf(
		transport.relay(ConsoleOp.Peek(target = target, sinceHash = sinceHash), targetGateway = transport.targetGatewayOf(target)),
		"peek",
	)

/** Send literal text OR a named control key to the target's tmux pane. `submit` (text only, default
 * true) controls the trailing Enter: false types into the composer without submitting. Idempotent
 * per opId (the host replays a re-relayed send instead of re-injecting). */
suspend fun ConsoleClient.tmuxSend(
	target: String,
	text: String? = null,
	key: String? = null,
	submit: Boolean = true,
	opId: String = UUID.randomUUID().toString(),
) {
	val body =
		transport.relay(
			ConsoleOp.TmuxSend(target = target, text = text, key = key, submit = submit),
			opId,
			targetGateway = transport.targetGatewayOf(target),
		)
	if (!body.ok) error("tmux_send failed: ${body.error ?: "unknown error"}")
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
	val body = transport.relay(op, opId, targetGateway = transport.targetGatewayOf(target))
	if (!body.ok) error("forget failed: ${body.error ?: "unknown error"}")
	return body.result
		?.let { runCatching { wireJson.decodeFromJsonElement<ConsoleForgetResult>(it) }.getOrNull() }
		?.boardDisposition
}

/** Close a session: kill its tmux but KEEP its resume record (a restart / mop-up), so it stays
 * listed as available. Idempotent per opId; the Gateway rejects a bare spawn-point, refuses while
 * a wake is in flight, and reports a user-launched session rather than a false success. */
suspend fun ConsoleClient.closeSession(target: String, opId: String = UUID.randomUUID().toString()) {
	val body = transport.relay(ConsoleOp.CloseSession(target = target), opId, targetGateway = transport.targetGatewayOf(target))
	if (!body.ok) error("close failed: ${body.error ?: "unknown error"}")
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
	transport.resultOf(
		transport.relay(
			ConsoleOp.CreateSession(target = target, sessionName = sessionName, displayLabel = displayLabel, workdir = workdir),
			opId,
			targetGateway = transport.targetGatewayOf(target),
		),
		"create_session",
	)

/** List the immediate subdirectories of one host directory (the create-session directory
 * picker's type-ahead). Read-only, fresh each call, like peek. The path must be absolute or
 * ~-rooted; an unreadable or missing one returns empty entries rather than an error.
 *
 * `hostTarget` names WHICH machine's filesystem to browse, and is the qualified host spawn point when
 * creating on another gateway. It was hardcoded bare, which resolves to the local gateway: picking a
 * directory for a session on another machine would have silently listed THIS one's filesystem and
 * handed back a path that does not exist there. */
suspend fun ConsoleClient.listDirs(path: String, hostTarget: String = "host"): ConsoleListDirsResult =
	transport.resultOf(
		transport.relay(ConsoleOp.ListDirs(path = path), targetGateway = transport.targetGatewayOf(hostTarget)),
		"list_dirs",
	)

/** Rename a session: set the gateway-authoritative sessionLabel on its record. Idempotent per
 * opId. Returns the label the gateway actually applied (after its sanitize + per-spawn dedup). */
suspend fun ConsoleClient.renameSession(
	target: String,
	sessionLabel: String,
	opId: String = UUID.randomUUID().toString(),
): ConsoleRenameSessionResult =
	transport.resultOf(
		transport.relay(
			ConsoleOp.RenameSession(target = target, sessionLabel = sessionLabel),
			opId,
			targetGateway = transport.targetGatewayOf(target),
		),
		"rename_session",
	)

/** Report this device's read position for a team, for the cross-device read-anchor sync plane
 * (monotonic per owner - see readAnchors.ts). No targetGateway override: this is owned by the
 * console's own mailbox, so it defaults to the route Gateway exactly like poll()/register().
 * Idempotent per opId (a retry re-applies the same merge, which is a no-op if it already landed). */
suspend fun ConsoleClient.reportRead(
	team: String,
	epoch: Long,
	seq: Long,
	opId: String = UUID.randomUUID().toString(),
): ConsoleReportReadResult =
	transport.resultOf(transport.relay(ConsoleOp.ReportRead(team = team, epoch = epoch, seq = seq), opId), "report_read")
