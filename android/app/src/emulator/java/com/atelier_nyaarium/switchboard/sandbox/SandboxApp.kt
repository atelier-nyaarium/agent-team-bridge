package com.atelier_nyaarium.switchboard.sandbox

import android.app.Application
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.Repo

/**
 * The `emulator` build type's entry point.
 *
 * EVERYTHING IN THIS SOURCE SET IS SCAFFOLDING, NOT A SPEC. Add a thread shape, delete a fixture,
 * or bend the canned state to whatever is being looked at this week. None of it is load-bearing and
 * none of it needs to stay consistent with anything. If a fixture stops being useful, remove it
 * rather than maintaining it.
 *
 * What this build is for: looking at the console without a Gateway, an owner key, an admission, or a
 * network. The real app cannot get past onboarding without all four, which meant every visual
 * question had to be answered by the owner on their phone. A CSS variable that was never defined
 * made every reference link in every message render as plain prose, and no test on either side of
 * the wire could see it. That is the class of bug this exists to catch.
 *
 * Nothing here is compiled into debug or release: this source set only belongs to the `emulator`
 * build type, and the one shared-code entry point it calls (`ChatRepository.seedSandbox`) checks its
 * own build type before doing anything.
 */
class SandboxApp : Application() {
	override fun onCreate() {
		super.onCreate()
		// An opt-in plugin is off by default, which is right for a real install and useless here: with
		// a link-claiming plugin off, its scheme renders as an inert red unhandled protocol and looks
		// broken. References is default-on now (AppStateStore.DEFAULT_ON_IDS) and deliberately NOT
		// listed here, so a fresh install of this build is what verifies that default still holds.
		for (id in SANDBOX_PLUGINS) AppStateStore(this).setPluginEnabled(id, true)

		val repo = Repo.get(this)
		val fixtures = SandboxFixtures(filesDir, assets)
		repo.seedSandbox(fixtures.teams(), fixtures.threads(), fixtures.dirs())
	}

	private companion object {
		/** Switched on before anything boots, for plugins a real device leaves opt-in. Add or drop ids
		 * freely; this is a convenience, not a statement about what a real device should have. */
		val SANDBOX_PLUGINS = listOf("designer")
	}
}
