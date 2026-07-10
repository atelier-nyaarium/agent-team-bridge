package com.atelier_nyaarium.switchboard.plugins

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the bus's teardown contract: one emitRetract sweeps everything, a plugin-owned
 * subscription fires for its own retract then auto-drops (subscribe IS the registration), and a
 * core subscription is permanent.
 */
class PluginLifecycleBusTest {

	@Test
	fun emitRetractInvokesEverySubscriberWithTheId() {
		val runtime = PluginRuntime()
		val seen = mutableListOf<String>()
		runtime.lifecycle.onRetract { seen.add("first:$it") }
		runtime.lifecycle.onRetract { seen.add("second:$it") }
		runtime.lifecycle.emitRetract("x")
		assertEquals(listOf("first:x", "second:x"), seen)
	}

	@Test
	fun pluginOwnedSubscriptionFiresForItsOwnRetractThenDrops() {
		val runtime = PluginRuntime()
		var fired = 0
		runtime.context.with("a") { runtime.lifecycle.onRetract { fired++ } }
		runtime.lifecycle.emitRetract("a")
		assertEquals(1, fired)
		// The subscription was owned by "a" and dropped with it; nothing fires again.
		runtime.lifecycle.emitRetract("a")
		runtime.lifecycle.emitRetract("b")
		assertEquals(1, fired)
	}

	@Test
	fun coreSubscriptionSurvivesEveryRetract() {
		val runtime = PluginRuntime()
		var fired = 0
		runtime.lifecycle.onRetract { fired++ }
		runtime.lifecycle.emitRetract("a")
		runtime.lifecycle.emitRetract("b")
		assertEquals(2, fired)
	}

	@Test
	fun aSubscriberMaySubscribeDuringAnEmit() {
		val runtime = PluginRuntime()
		var lateFired = 0
		runtime.lifecycle.onRetract {
			// A callback registering another subscription mid-walk must not blow up the walk
			// (the emit iterates a defensive snapshot).
			runtime.lifecycle.onRetract { lateFired++ }
		}
		runtime.lifecycle.emitRetract("a")
		assertEquals(0, lateFired)
		runtime.lifecycle.emitRetract("b")
		assertEquals(1, lateFired)
	}
}
