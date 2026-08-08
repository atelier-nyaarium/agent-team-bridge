package com.atelier_nyaarium.switchboard.plugins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Pins the claim table's two load-bearing invariants: every claim is tagged with the source that
 * made it (without the source saying so), and a key collision REFUSES instead of shadowing - silent
 * last-wins override is a modding-ecosystem feature, not something a first-party app should tolerate.
 */
class PluginRegistryTest {

	@Test
	fun claimInsideAContextIsTaggedWithThatSource() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<String>("slots")
		runtime.context.with("nyaarium.designer") { reg.claim("designer:dock", "v") }
		assertEquals("nyaarium.designer", reg.sourceOf("designer:dock"))
		assertEquals("v", reg.get("designer:dock"))
	}

	@Test
	fun claimOutsideAnyContextIsCore() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<String>("slots")
		reg.claim("core-thing", "v")
		assertEquals(CORE_SOURCE, reg.sourceOf("core-thing"))
	}

	@Test
	fun duplicateKeyRefusesLoudly() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<String>("slots")
		runtime.context.with("a") { reg.claim("k", "first") }
		val err = assertThrows(IllegalStateException::class.java) {
			runtime.context.with("b") { reg.claim("k", "second") }
		}
		// The refusal names the first claimer, so a collision is diagnosable from the message.
		assertEquals(true, err.message!!.contains("\"a\""))
		assertEquals("first", reg.get("k"))
	}

	@Test
	fun retractSweepsOnlyThatSourcesClaims() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<String>("slots")
		runtime.context.with("a") { reg.claim("a:one", "1") }
		runtime.context.with("b") { reg.claim("b:two", "2") }
		reg.claim("core:three", "3")
		runtime.lifecycle.emitRetract("a")
		assertNull(reg.get("a:one"))
		assertEquals("2", reg.get("b:two"))
		assertEquals("3", reg.get("core:three"))
		assertEquals(2, reg.size())
	}

	@Test
	fun aKeyIsClaimableAgainAfterItsSourceRetracts() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<String>("slots")
		runtime.context.with("a") { reg.claim("k", "old") }
		runtime.lifecycle.emitRetract("a")
		runtime.context.with("a") { reg.claim("k", "new") }
		assertEquals("new", reg.get("k"))
	}

	@Test
	fun contextPopsEvenWhenTheBlockThrows() {
		val runtime = PluginRuntime()
		runCatching { runtime.context.with("a") { error("boom") } }
		assertEquals("", runtime.context.current())
	}

	@Test
	fun forEachCaughtContinuesPastAThrowingClaim() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<() -> String>("handlers")
		runtime.context.with("a") { reg.claim("a:boom") { error("boom") } }
		runtime.context.with("b") { reg.claim("b:fine") { "ran" } }
		val ran = mutableListOf<String>()
		val errors = mutableListOf<String>()
		reg.forEachCaught(onError = { msg, _ -> errors.add(msg) }) { ran.add(it()) }
		assertEquals(listOf("ran"), ran)
		// The report names the claim and its source, so a broken plugin is diagnosable from the log.
		assertEquals(1, errors.size)
		assertEquals(true, errors[0].contains("a:boom"))
		assertEquals(true, errors[0].contains("\"a\""))
	}

	@Test
	fun anyCaughtTreatsAThrowAsNotClaimedAndKeepsChecking() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<() -> Boolean>("openers")
		runtime.context.with("a") { reg.claim("a:boom") { error("boom") } }
		runtime.context.with("b") { reg.claim("b:claims") { true } }
		assertEquals(true, reg.anyCaught { it() })
		runtime.lifecycle.emitRetract("b")
		assertEquals(false, reg.anyCaught { it() })
	}

	@Test
	fun firstNotNullCaughtSkipsThrowsAndNullsUntilAValue() {
		val runtime = PluginRuntime()
		val reg = runtime.createRegistry<() -> String?>("decorators")
		runtime.context.with("a") { reg.claim("a:boom") { error("boom") } }
		runtime.context.with("b") { reg.claim("b:null") { null } }
		runtime.context.with("c") { reg.claim("c:wins") { "deco" } }
		assertEquals("deco", reg.firstNotNullCaught { it() })
		runtime.lifecycle.emitRetract("c")
		assertNull(reg.firstNotNullCaught { it() })
	}
}
