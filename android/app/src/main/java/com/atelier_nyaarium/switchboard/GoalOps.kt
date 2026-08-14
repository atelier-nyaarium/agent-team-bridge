package com.atelier_nyaarium.switchboard

import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch

/**
 * Goals armed against a session (`repo.goals`): send the message, then type a `/goal` line into that
 * session's pane as soon as its composer is free.
 *
 * The turn is deliberately not waited on. The message goes over the wire, so the composer stays free
 * while the agent works, and a line typed there is queued and runs when the turn ends.
 */
internal class GoalOps(private val repo: ChatRepository) {
	// Teams whose await loop is running here. An arm and the poll tick both call drive(), and two
	// loops reaching Inject together would type the goal twice.
	private val driving = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	/**
	 * Arm a goal and send the message it rides on, replacing any goal already armed for this team.
	 * A send that does not land disarms again.
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
					when (val step = goalStep(rec, System.currentTimeMillis(), capturePane(team))) {
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
						GoalStep.Wait -> delay(GOAL_POLL_MS)
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
