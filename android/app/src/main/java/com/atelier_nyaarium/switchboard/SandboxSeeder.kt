package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update

internal interface SandboxSeeder {
	fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>> = emptyMap(),
		drafts: Map<String, Draft> = emptyMap(),
		goals: Map<String, PendingGoal> = emptyMap(),
		admittedGateways: List<String> = emptyList(),
	)
}

internal class ChatRepositorySandboxSeeder(private val repo: ChatRepository) : SandboxSeeder {
	@Volatile private var dirs: Map<String, List<String>>? = null
	val sandboxDirs: Map<String, List<String>>? get() = dirs

	override fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>>,
		drafts: Map<String, Draft>,
		goals: Map<String, PendingGoal>,
		admittedGateways: List<String>,
	) {
		if (BuildConfig.BUILD_TYPE != "emulator") return
		teams.firstOrNull()?.name?.split(".")?.getOrNull(1)?.let { repo.homeGatewayId = it }
		if (repo.store.load() == null) repo.store.save(SANDBOX_PROVISIONING)
		this.dirs = dirs
		repo._state.update { s ->
			s.copy(
				teams = teams,
				threads = threads,
				openTabs = threads.keys.toList(),
				unread = threads.mapValues { (team, msgs) -> unreadCount(msgs, s.readAnchors[team]) },
				connected = true,
				provisioned = true,
				status = "",
				error = null,
				drafts = drafts,
				goals = goals,
				admittedGateways = admittedGateways,
				homeGatewayId = repo.homeGatewayId,
			)
		}
	}

	private companion object {
		/** Sandbox provisioning blob. */
		val SANDBOX_PROVISIONING =
			"""{"transport":"direct","routerUrl":"https://router.sandbox.invalid:20001",""" +
				""""routerCertFp":"${"11".repeat(32)}","appToken":"sandbox","conversationId":"sandbox"}"""
	}
}
