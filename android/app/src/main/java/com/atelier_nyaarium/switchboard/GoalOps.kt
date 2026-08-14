package com.atelier_nyaarium.switchboard

import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch

/**
 * Goals armed against a session (`repo.goals`): the record, the wait it drives, and the one place
 * that types a `/goal` line into a pane. Holds the per-team driver set, which is why it is a held
 * delegate rather than extensions the way the voice settings and the drafts are.
 *
 * The wait is two halves and both are needed. The session's own reply is what "the message landed
 * and was worked" means; the pane being ready is what makes a slash command a command rather than
 * text queued into a busy composer. Waiting on either one alone types into the wrong moment.
 */
internal class GoalOps(private val repo: ChatRepository) {
	init {
		// Registered from here rather than from the service: ChatRepository is a process singleton and
		// this constructor runs once, while a service recreation would add a second, double-delivering
		// subscriber (addIfAbsent cannot see two distinct lambdas as the same claim). Requires `drain`
		// to already exist, which is why this delegate is declared after it.
		repo.drain.addInboundSubscriber(InboundSubscriber { team, msg -> onInbound(team, msg) })
	}

	// Teams whose await loop is running in THIS process. A fresh arm, a landing reply and the poll
	// tick all call drive(); without this claim they would run three loops over one record, and three
	// loops reaching Inject together would type the goal three times.
	private val driving = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	/**
	 * Arm a goal for `team` and send the composed message it rides on. Replaces any goal already armed
	 * for this team - the dock is the sole surface for one, so a second Goal is a deliberate replace
	 * rather than a queue.
	 *
	 * Arming happens BEFORE the send, because the record is what recognizes the reply and a session
	 * can answer before send() has returned. A send that does not land disarms again: a goal typed
	 * into a session that never received the message would be a goal for nothing.
	 *
	 * Returns false when nothing was armed, which is the caller's signal to keep the composer intact.
	 */
	suspend fun armAndSend(team: String, goal: String, text: String, uris: List<Uri>): Boolean {
		val clean = sanitizeGoalText(goal)
		if (clean.isEmpty()) {
			repo._state.update { it.copy(error = "Type what the goal is before setting one.") }
			return false
		}
		putGoal(team, PendingGoal(clean, System.currentTimeMillis()))
		// runCatchingCancellable, not a bare call: send() settles its own wire failures internally, but
		// admission and the on-disk staging above it can still throw, and a throw that escaped here
		// would leave a goal armed against a message that was never sent.
		val opId = runCatchingCancellable { repo.send(team, text, uris) }
			.onFailure { DebugLog.log("Goal", "send threw while arming: ${it.javaClass.simpleName}") }
			.getOrNull()
		val settled = opId?.let { id -> repo._state.value.threads[team]?.firstOrNull { it.opId == id } }
		if (settled == null || settled.status == "error") {
			clearGoal(team)
			// send()/deliver() already put the cause in state.error; this says what it cost, since the
			// user asked for two things and only the failure of the first is otherwise visible.
			repo._state.update { it.copy(error = "That message did not send, so no goal was set.") }
			return false
		}
		// The send is genuinely out. Only now may anything be typed (see goalStep's own sentAt gate).
		updateGoal(team) { it.copy(sentAt = System.currentTimeMillis()) }
		DebugLog.log("Goal", "armed for $team (${clean.length} chars)")
		drive(team)
		return true
	}

	/** Drop team's armed goal, if any. The UI's cancel, and what a forget calls so nothing is left
	 * waiting to type into a session that no longer exists. */
	fun cancelGoal(team: String) {
		if (repo._state.value.goals[team] == null) return
		clearGoal(team)
	}

	/**
	 * The drain-gate subscriber: a genuinely-new inbound row for a team with a goal still awaiting one.
	 * Fast, non-blocking and idempotent, as that gate requires - it stamps the record and hands the
	 * actual waiting to a coroutine. What counts as the session answering is [isGoalReply]'s call.
	 */
	private fun onInbound(team: String, msg: Message) {
		if (!isGoalReply(msg)) return
		val rec = repo._state.value.goals[team] ?: return
		if (rec.replyAt != null) return
		updateGoal(team) { if (it.replyAt == null) it.copy(replyAt = System.currentTimeMillis()) else it }
		DebugLog.log("Goal", "reply seen for $team; waiting for its pane")
		drive(team)
	}

	/** Poll-cadence tick: start a driver for any armed goal that has none - a cold start restoring a
	 * record from disk, or a loop that lost its race with a re-provision. A no-op when nothing is
	 * armed, which is every pass in the ordinary case. */
	fun tick() {
		for (team in repo._state.value.goals.keys) drive(team)
	}

	/** Run the wait for one team, at most once per process. Ends by typing, by expiring, or by
	 * finding the record gone (cancelled, forgotten, re-provisioned). */
	private fun drive(team: String) {
		if (!driving.add(team)) return
		repo.repoScope.launch {
			try {
				while (true) {
					val rec = repo._state.value.goals[team] ?: return@launch
					// Peeking is skipped entirely while the reply is outstanding: a session mid-turn is not
					// idle in any sense this cares about, and a peek every couple of seconds for up to an
					// hour is a real cost on a phone for an answer that cannot matter yet.
					val screen = if (rec.replyAt == null) null else capturePane(team)
					when (val step = goalStep(rec, System.currentTimeMillis(), screen)) {
						is GoalStep.Expire -> {
							clearGoal(team)
							repo._state.update { it.copy(error = "Goal dropped: ${step.reason}.") }
							DebugLog.log("Goal", "expired for $team: ${step.reason}")
							return@launch
						}
						GoalStep.Inject -> {
							inject(team, rec.text)
							return@launch
						}
						GoalStep.AwaitReply -> delay(GOAL_REPLY_POLL_MS)
						GoalStep.AwaitIdle -> delay(GOAL_IDLE_POLL_MS)
					}
				}
			} finally {
				driving.remove(team)
			}
		}
	}

	/** The latest pane for `team`, or null when there is nothing a slash command could be typed into.
	 * A container-logs frame is a booting session with no pane yet, never a screen to read readiness
	 * off - the same refusal deriveFromPeek makes on the daemon's side. */
	private suspend fun capturePane(team: String): String? {
		val r = repo.sessions.peekTerminal(team, null).getOrNull() ?: return null
		if (r.kind == "container-logs") return null
		return r.ansi
	}

	/**
	 * Type the goal into team's pane.
	 *
	 * THREE sends, never one line. The CLI folds a burst of typed characters into a clipboard paste,
	 * and a whole "/goal ..." line pasted at once is not read as a command at all - so the prefix goes
	 * alone, the description follows as its own paste, and Enter is its own keypress (a trailing CR on
	 * the text reads as inserted text rather than a submit, which is the same reason resumeAfterLimit
	 * is three sends).
	 *
	 * The record is cleared BEFORE the first keystroke, deliberately. A process death mid-sequence
	 * would otherwise leave a record that types "/goal " into a composer already holding half of one
	 * on the next start; losing a goal is recoverable by re-arming it, and a session that has been
	 * typed at twice is not.
	 */
	private suspend fun inject(team: String, goal: String) {
		clearGoal(team)
		runCatchingCancellable {
			repo.sessions.tmuxSend(team, text = GOAL_COMMAND, submit = false)
			repo.sessions.tmuxSend(team, text = goal, submit = false)
			repo.sessions.tmuxSend(team, key = "Enter")
		}
			.onSuccess { DebugLog.log("Goal", "typed into $team") }
			.onFailure { e ->
				DebugLog.log("Goal", "typing into $team failed: ${e.javaClass.simpleName}")
				// Through the same classifier the send path and the poll loop use, so this reads as a
				// cause rather than a raw "HTTP 502: {json}".
				val (cause, _) = classifyConnError(e)
				repo._state.update { it.copy(error = "Could not type the goal into that session: $cause") }
			}
	}

	////////////////////////////////
	//  Record mutations
	//
	//  Every write lands in ChatState (so the dock is Compose-reactive) and in the same durable slot,
	//  so a restart resumes the wait rather than silently abandoning it.

	private fun putGoal(team: String, rec: PendingGoal) {
		val next = repo._state.updateAndGet { s -> s.copy(goals = s.goals + (team to rec)) }.goals
		repo.persistence.persistGoals(next)
	}

	/** Apply [edit] to team's record if it still exists. Reads inside the state update, so a cancel
	 * landing between a read and a write cannot be undone by the write. */
	private fun updateGoal(team: String, edit: (PendingGoal) -> PendingGoal) {
		val next = repo._state.updateAndGet { s ->
			val rec = s.goals[team] ?: return@updateAndGet s
			s.copy(goals = s.goals + (team to edit(rec)))
		}.goals
		repo.persistence.persistGoals(next)
	}

	private fun clearGoal(team: String) {
		val next = repo._state.updateAndGet { s -> s.copy(goals = s.goals - team) }.goals
		repo.persistence.persistGoals(next)
	}
}
