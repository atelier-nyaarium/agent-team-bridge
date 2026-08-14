package com.atelier_nyaarium.switchboard

import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch

/**
 * Goals armed against a session (`repo.goals`): the wait between sending a message and typing a
 * `/goal` line into that session's pane.
 *
 * The wait is two halves and needs both. The reply is what "the message was worked" means; the pane
 * being ready is what makes a slash command a command rather than text queued into a busy composer.
 */
internal class GoalOps(private val repo: ChatRepository) {
	init {
		// Once per process, unlike a service recreation, which would add a second delivering subscriber.
		// Needs `drain`, so this delegate stays declared after it.
		repo.drain.addInboundSubscriber(InboundSubscriber { team, msg -> onInbound(team, msg) })
	}

	// Teams whose await loop is running here. An arm, a landing reply and the tick all call drive(),
	// and three loops reaching Inject together would type the goal three times.
	private val driving = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	/**
	 * Arm a goal and send the message it rides on, replacing any goal already armed for this team.
	 *
	 * Arms BEFORE the send: the record is what recognizes the reply, and a session can answer before
	 * send() returns. A send that does not land disarms again.
	 *
	 * Returns false when nothing was armed, so the caller keeps the composer intact.
	 */
	suspend fun armAndSend(team: String, goal: String, text: String, uris: List<Uri>): Boolean {
		val clean = sanitizeGoalText(goal)
		if (clean.isEmpty()) {
			repo._state.update { it.copy(error = "Type what the goal is before setting one.") }
			return false
		}
		putGoal(team, PendingGoal(clean, System.currentTimeMillis()))
		// send() settles its own wire failures, but admission and staging above it can still throw.
		val opId = runCatchingCancellable { repo.send(team, text, uris) }
			.onFailure { DebugLog.log("Goal", "send threw while arming: ${it.javaClass.simpleName}") }
			.getOrNull()
		val settled = opId?.let { id -> repo._state.value.threads[team]?.firstOrNull { it.opId == id } }
		if (settled == null || settled.status == "error") {
			clearGoal(team)
			// deliver() already put the cause in state.error; this says what it cost.
			repo._state.update { it.copy(error = "That message did not send, so no goal was set.") }
			return false
		}
		updateGoal(team) { it.copy(sentAt = System.currentTimeMillis()) }
		DebugLog.log("Goal", "armed for $team (${clean.length} chars)")
		drive(team)
		return true
	}

	/** The UI's cancel, and what a forget calls so nothing waits on a session that is gone. */
	fun cancelGoal(team: String) {
		if (repo._state.value.goals[team] == null) return
		clearGoal(team)
	}

	/** Drain-gate subscriber: stamps the record and hands the waiting to a coroutine. */
	private fun onInbound(team: String, msg: Message) {
		if (!isGoalReply(msg)) return
		val rec = repo._state.value.goals[team] ?: return
		if (rec.replyAt != null) return
		updateGoal(team) { if (it.replyAt == null) it.copy(replyAt = System.currentTimeMillis()) else it }
		DebugLog.log("Goal", "reply seen for $team; waiting for its pane")
		drive(team)
	}

	/** Poll-cadence tick: starts a driver for a goal that has none, e.g. one restored from disk. */
	fun tick() {
		for (team in repo._state.value.goals.keys) drive(team)
	}

	/** Runs the wait for one team, at most once per process. */
	private fun drive(team: String) {
		if (!driving.add(team)) return
		repo.repoScope.launch {
			try {
				while (true) {
					val rec = repo._state.value.goals[team] ?: return@launch
					// No peeking until it has answered: a session mid-turn cannot be idle yet, and peeking
					// every couple of seconds for up to an hour is a real cost on a phone.
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

	/** Null when there is no pane to type into. A container-logs frame is a session still booting. */
	private suspend fun capturePane(team: String): String? {
		val r = repo.sessions.peekTerminal(team, null).getOrNull() ?: return null
		if (r.kind == "container-logs") return null
		return r.ansi
	}

	/**
	 * Three sends, never one line. The CLI folds a burst of typed characters into a paste, and a whole
	 * `/goal ...` line pasted at once is read as no command. Enter is its own keypress, since a
	 * trailing CR reads as inserted text (same shape as resumeAfterLimit).
	 *
	 * Cleared before the first keystroke: a process death mid-sequence would otherwise type into a
	 * composer already holding half a goal. Losing one is re-armable, a session typed at twice is not.
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
				val (cause, _) = classifyConnError(e)
				repo._state.update { it.copy(error = "Could not type the goal into that session: $cause") }
			}
	}

	////////////////////////////////
	//  Record mutations
	//
	//  Every write lands in ChatState and in the durable slot, so a restart resumes the wait.

	private fun putGoal(team: String, rec: PendingGoal) {
		val next = repo._state.updateAndGet { s -> s.copy(goals = s.goals + (team to rec)) }.goals
		repo.persistence.persistGoals(next)
	}

	/** Reads inside the update, so a cancel landing mid-edit cannot be undone by the write. */
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
