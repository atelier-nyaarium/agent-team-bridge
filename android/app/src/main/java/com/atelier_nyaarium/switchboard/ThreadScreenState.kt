package com.atelier_nyaarium.switchboard

import android.net.Uri

////////////////////////////////
//  Interfaces & Types

/** The composer as one subject: what it shows, what Send consumes, and every draft edit. */
data class ComposerState(
	/** The single source read by the text field, the chips, and every occupied/enabled check, so a
	 * tab switch can never bleed one thread's picked files into another's. */
	val draft: Draft,
	/** A send is waiting on this team's cold boot (ChatState.wakingTeams); draws the notice card. */
	val sendAwaitingWake: Boolean,
	val onSend: (String, List<Uri>) -> Unit,
	val onTextChange: (String) -> Unit,
	val onAddFiles: (List<Uri>) -> Unit,
	val onRemoveFile: (String) -> Unit,
	val onOpenFile: (MessageFile) -> Unit,
	/** The plugin dock's composer-insert seam (e.g. the Designer's "Reference in chat"). */
	val onAppendText: (String) -> Unit,
	/** Drops the draft and reclaims its now-unreferenced attachment copies after Send hands off. */
	val onClear: () -> Unit,
)

/** This team's scheduled send: the banked record driving the dock, and its lifecycle. */
data class ScheduledSendState(
	/** At most one pending record, null otherwise; also gates the long-press Schedule Send item. */
	val record: ScheduledSend?,
	/** suspend + Boolean: the repo-side time check is authoritative, and the caller must await the
	 * real outcome before clearing the composer or a failure destroys the user's message. */
	val onSchedule: suspend (String, List<Uri>, Long) -> Boolean,
	/** Time-only on purpose: the banked attachments are copied MessageFile refs, not the live
	 * content:// Uris onSchedule takes, so a full re-edit would risk a silent attachment drop. */
	val onReschedule: suspend (Long) -> Boolean,
	/** Cancels and hands the content back into the draft; the dock reads the result through it. */
	val onCancel: () -> Unit,
)

/** The terminal view and the session-health facts it decides from. */
data class TerminalState(
	/** Only the host-agent and devcontainers have a daemon-drivable pane. */
	val eligible: Boolean,
	val sessionStatus: String?,
	/** A session wake is in flight, a different fact from ComposerState.sendAwaitingWake. */
	val wakeInFlight: Boolean,
	/** Daemon-derived (presence plane), true independent of sessionStatus: the one signal at tap
	 * time that separates a stuck boot from a plain one still in progress. */
	val needsLogin: Boolean,
	val limitBlocked: Boolean,
	val limitDetail: String?,
	val refreshMs: Long,
	val onWake: () -> Unit,
	/** Force-relaunch claude in a still-existing pane (SessionOps.relaunchSession). */
	val onRelaunch: suspend () -> Unit,
	val onPeek: suspend (sinceHash: String?) -> Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult>,
	val onSend: suspend (text: String?, key: String?, submit: Boolean) -> Unit,
	/** Clear a usage-limit dialog and pick the work back up (SessionOps.resumeAfterLimit). */
	val onResumeAfterLimit: suspend () -> Unit,
)
