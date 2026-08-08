package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Functions & Helpers

/** Whether a team's burst should get full notification treatment (banner + TTS). The
 * burst still bumps unread/mailbox state in the drain loop regardless of this decision - it only
 * gates `notifyBurst`'s banner/TTS path. False while the Activity is visible (the user is already
 * looking at the app), notifications are otherwise unavailable, or the team's tab is muted
 * (explicitly Closed and not yet reopened; a never-opened team is not muted). */
internal fun shouldNotifyBurst(isVisible: Boolean, canNotify: Boolean, closedTeams: Set<String>, team: String): Boolean =
	!isVisible && canNotify && team !in closedTeams
