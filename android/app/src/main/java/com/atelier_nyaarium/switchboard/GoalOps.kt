package com.atelier_nyaarium.switchboard

import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch

internal interface GoalOpsCollaborators {
	suspend fun send(team: String, text: String, uris: List<Uri>): String?
	suspend fun peekTerminal(team: String): Result<com.atelier_nyaarium.switchboard.proto.ConsolePeekResult>
	suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean)
}

internal class GoalOps(
	private val state: MutableStateFlow<ChatState>,
	private val persistence: ChatPersistence,
	private val repoScope: CoroutineScope,
	private val sessions: GoalOpsCollaborators,
) {
	// Prevent concurrent drivers from injecting one goal twice.
	private val driving = java.util.Collections.synchronizedSet(mutableSetOf<String>())

	suspend fun armAndSend(team: String, goal: String, text: String, uris: List<Uri>): Boolean {
		val clean = sanitizeGoalText(goal)
		if (clean.isEmpty()) {
		state.update { it.copy(error = "Type what the goal is before setting one.") }
			return false
		}
		putGoal(team, PendingGoal(clean, System.currentTimeMillis()))
		val opId = runCatchingCancellable { sessions.send(team, text, uris) }
			.onFailure { DebugLog.log("Goal", "send threw while arming: ${it.javaClass.simpleName}") }
			.getOrNull()
		val settled = opId?.let { id -> state.value.threads[team]?.firstOrNull { it.opId == id } }
		if (settled == null || settled.status == "error") {
			clearGoal(team)
			state.update { it.copy(error = "That message did not send, so no goal was set.") }
			return false
		}
		updateGoal(team) { it.copy(sentAt = System.currentTimeMillis()) }
		DebugLog.log("Goal", "armed for $team (${clean.length} chars)")
		drive(team)
		return true
	}

	fun cancelGoal(team: String) {
		if (state.value.goals[team] == null) return
		clearGoal(team)
	}

	fun tick() {
		for (team in state.value.goals.keys) drive(team)
	}

	private fun drive(team: String) {
		if (!driving.add(team)) return
		repoScope.launch {
			try {
				while (true) {
					val rec = state.value.goals[team] ?: return@launch
					when (val step = goalStep(rec, System.currentTimeMillis(), capturePane(team))) {
						is GoalStep.Expire -> {
							clearGoal(team)
							state.update { it.copy(error = "Goal dropped: ${step.reason}.") }
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

	private suspend fun capturePane(team: String): String? {
		val r = sessions.peekTerminal(team).getOrNull() ?: return null
		if (r.kind == "container-logs") return null
		return r.ansi
	}

	private suspend fun inject(team: String, goal: String) {
		// Separate character input from Enter. Clear before typing.
		clearGoal(team)
		runCatchingCancellable {
			sessions.tmuxSend(team, text = GOAL_COMMAND, key = null, submit = false)
			sessions.tmuxSend(team, text = goal, key = null, submit = false)
			sessions.tmuxSend(team, key = "Enter", text = null, submit = false)
		}
			.onSuccess { DebugLog.log("Goal", "typed into $team") }
			.onFailure { e ->
				DebugLog.log("Goal", "typing into $team failed: ${e.javaClass.simpleName}")
				val (cause, _) = classifyConnError(e)
			state.update { it.copy(error = "Could not type the goal into that session: $cause") }
			}
	}

	// Persist every mutation so a restart resumes the wait.
	private fun putGoal(team: String, rec: PendingGoal) {
		val next = state.updateAndGet { s -> s.copy(goals = s.goals + (team to rec)) }.goals
		persistence.persistGoals(next)
	}

	private fun updateGoal(team: String, edit: (PendingGoal) -> PendingGoal) {
		val next = state.updateAndGet { s ->
			val rec = s.goals[team] ?: return@updateAndGet s
			s.copy(goals = s.goals + (team to edit(rec)))
		}.goals
		persistence.persistGoals(next)
	}

	private fun clearGoal(team: String) {
		val next = state.updateAndGet { s -> s.copy(goals = s.goals - team) }.goals
		persistence.persistGoals(next)
	}
}
