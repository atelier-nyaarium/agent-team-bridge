package com.atelier_nyaarium.switchboard.plugins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the manager's lifecycle behavior end to end with a synthetic catalog: enable runs the
 * entry inside its source window, disable is one retract sweep, `requires` gates both directions
 * as a plain assert, and a broken or throwing plugin can never stay half-live.
 */
class PluginManagerTest {

	private class FakeStore(vararg on: String) : PluginManager.EnabledStore {
		val flags = mutableMapOf<String, Boolean>().apply { on.forEach { put(it, true) } }

		override fun isEnabled(id: String): Boolean = flags[id] ?: false

		override fun setEnabled(id: String, on: Boolean) {
			flags[id] = on
		}
	}

	private class Fixture(
		manifests: Map<String, String>,
		catalog: List<PluginCatalog.Entry>,
		store: FakeStore = FakeStore(),
	) {
		val runtime = PluginRuntime()
		val registry = runtime.createRegistry<String>("test-slots")
		val store2 = store
		val manager = PluginManager(
			runtime = runtime,
			// ContextWrapper(null) is a concrete Context instance with no Robolectric; the manager
			// tests never touch the host's context (their entries claim into `registry`, not the host).
			host = PluginHost(runtime, android.content.ContextWrapper(null)),
			enabledStore = store,
			readManifest = { dir -> manifests[dir] ?: error("no manifest for $dir") },
			catalog = catalog,
		)
	}

	private fun manifest(id: String, requires: List<String> = emptyList(), author: String = ""): String {
		val req = requires.joinToString(",") { """{ "content_id": "$it" }""" }
		val authorField = if (author.isEmpty()) "" else """"author": "$author","""
		return """{ $authorField "content_id": "$id", "display_name": "${id.replaceFirstChar { it.uppercase() }}", "requires": [$req] }"""
	}

	@Test
	fun bootLoadsOnlyEnabledPlugins() {
		var aRan = 0
		var bRan = 0
		val fx = Fixture(
			manifests = mapOf("a" to manifest("a"), "b" to manifest("b")),
			catalog = listOf(
				PluginCatalog.Entry("a") { aRan++ },
				PluginCatalog.Entry("b") { bRan++ },
			),
			store = FakeStore("a"),
		)
		fx.manager.boot()
		assertEquals(1, aRan)
		assertEquals(0, bRan)
		assertTrue(fx.manager.isActive("a"))
		assertFalse(fx.manager.isActive("b"))
	}

	@Test
	fun enableRunsTheEntryInsideItsSourceWindow() {
		lateinit var fx: Fixture
		fx = Fixture(
			manifests = mapOf("a" to manifest("a")),
			catalog = listOf(PluginCatalog.Entry("a") { fx.registry.claim("a:slot", "v") }),
		)
		fx.manager.boot()
		assertNull(fx.manager.setEnabled("a", true))
		// The claim auto-tagged with the plugin's composite id, not core.
		assertEquals("a", fx.registry.sourceOf("a:slot"))
	}

	@Test
	fun disableSweepsTheClaimsAndReEnableReclaims() {
		lateinit var fx: Fixture
		fx = Fixture(
			manifests = mapOf("a" to manifest("a")),
			catalog = listOf(PluginCatalog.Entry("a") { fx.registry.claim("a:slot", "v") }),
		)
		fx.manager.boot()
		fx.manager.setEnabled("a", true)
		assertEquals(1, fx.registry.size())

		assertNull(fx.manager.setEnabled("a", false))
		assertEquals(0, fx.registry.size())
		assertFalse(fx.manager.isActive("a"))
		assertEquals(false, fx.store2.flags["a"])

		assertNull(fx.manager.setEnabled("a", true))
		assertEquals("v", fx.registry.get("a:slot"))
		assertTrue(fx.manager.isActive("a"))
	}

	@Test
	fun enableRefusesWhileARequiredDepIsOff() {
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
		)
		fx.manager.boot()
		val refusal = fx.manager.setEnabled("top", true)
		assertNotNull(refusal)
		assertTrue(refusal!!.contains("dep"))
		assertFalse(fx.manager.isActive("top"))

		assertNull(fx.manager.setEnabled("dep", true))
		assertNull(fx.manager.setEnabled("top", true))
		assertTrue(fx.manager.isActive("top"))
	}

	@Test
	fun disableRefusesWhileAnEnabledPluginStillRequiresIt() {
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
		)
		fx.manager.boot()
		fx.manager.setEnabled("dep", true)
		fx.manager.setEnabled("top", true)

		val refusal = fx.manager.setEnabled("dep", false)
		assertNotNull(refusal)
		assertTrue(fx.manager.isActive("dep"))

		assertNull(fx.manager.setEnabled("top", false))
		assertNull(fx.manager.setEnabled("dep", false))
	}

	@Test
	fun bootSkipsAnEnabledPluginWhoseDepIsOffWithoutClearingItsFlag() {
		val store = FakeStore("top")
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
			store = store,
		)
		fx.manager.boot()
		assertFalse(fx.manager.isActive("top"))
		// The opt-in is the user's; a skipped boot never flips it behind their back.
		assertEquals(true, store.flags["top"])
	}

	@Test
	fun brokenManifestSurfacesAndItsToggleRefuses() {
		val fx = Fixture(
			manifests = mapOf("bad" to "{ not json"),
			catalog = listOf(PluginCatalog.Entry("bad") {}),
		)
		fx.manager.boot()
		val state = fx.manager.states().single()
		assertNotNull(state.broken)
		assertNotNull(fx.manager.setEnabled("bad", true))
		assertFalse(fx.manager.isActive("bad"))
	}

	@Test
	fun duplicateCompositeIdMarksTheLaterRecordBroken() {
		val fx = Fixture(
			manifests = mapOf("one" to manifest("same"), "two" to manifest("same")),
			catalog = listOf(PluginCatalog.Entry("one") {}, PluginCatalog.Entry("two") {}),
		)
		val states = fx.manager.states()
		assertNull(states[0].broken)
		assertNotNull(states[1].broken)
	}

	@Test
	fun aThrowingEntryIsSweptAndMarkedBrokenNeverHalfLive() {
		lateinit var fx: Fixture
		fx = Fixture(
			manifests = mapOf("a" to manifest("a")),
			catalog = listOf(
				PluginCatalog.Entry("a") {
					fx.registry.claim("a:partial", "leaked?")
					error("entry blew up")
				},
			),
		)
		fx.manager.boot()
		val refusal = fx.manager.setEnabled("a", true)
		assertNotNull(refusal)
		// The partial claim was retract-swept on the failure path.
		assertEquals(0, fx.registry.size())
		assertFalse(fx.manager.isActive("a"))
		assertNotNull(fx.manager.states().single().broken)
		// The flag persists only AFTER a successful load, so the failed enable left it off - a
		// stranded-on flag with a dead toggle was the red-team's broken-flag-lockout finding.
		assertEquals(false, fx.store2.flags["a"] ?: false)
	}

	@Test
	fun aPluginBrokenByAFailingBootCanStillBeSwitchedOff() {
		// The flag was persisted by an earlier healthy session; THIS boot's entry throws.
		val store = FakeStore("a")
		val fx = Fixture(
			manifests = mapOf("a" to manifest("a")),
			catalog = listOf(PluginCatalog.Entry("a") { error("broke this session") }),
			store = store,
		)
		fx.manager.boot()
		assertNotNull(fx.manager.states().single().broken)
		assertEquals(true, store.flags["a"])
		// Switching OFF is reachable regardless of broken; switching back ON stays refused.
		assertNull(fx.manager.setEnabled("a", false))
		assertEquals(false, store.flags["a"])
		assertNotNull(fx.manager.setEnabled("a", true))
	}

	@Test
	fun disableRefusesADepNamedByCompositeId() {
		// "top" names its dep by the composite id; the disable gate must see that dependency the
		// same way the enable gate does (the red-team's gate-asymmetry finding).
		val fx = Fixture(
			manifests = mapOf(
				"dep" to manifest("dep", author = "nyaa"),
				"top" to manifest("top", requires = listOf("nyaa.dep")),
			),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
		)
		fx.manager.boot()
		assertNull(fx.manager.setEnabled("nyaa.dep", true))
		assertNull(fx.manager.setEnabled("top", true))
		assertNotNull(fx.manager.setEnabled("nyaa.dep", false))
		assertTrue(fx.manager.isActive("nyaa.dep"))
	}

	@Test
	fun aDependentListedBeforeItsDepStillBoots() {
		// Catalog order must never decide correctness: boot passes to a fixpoint, so the
		// dependent loads on the second pass.
		val store = FakeStore("dep", "top")
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("top") {}, PluginCatalog.Entry("dep") {}),
			store = store,
		)
		fx.manager.boot()
		assertTrue(fx.manager.isActive("dep"))
		assertTrue(fx.manager.isActive("top"))
	}

	@Test
	fun statesTrackEveryLiveTransition() {
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
		)
		fx.manager.boot()
		fun state(id: String) = fx.manager.states().first { it.id == id }

		// A refused enable (dep off) moves neither the flag nor liveness.
		assertNotNull(fx.manager.setEnabled("top", true))
		assertEquals(false, state("top").enabled)
		assertEquals(false, state("top").active)

		fx.manager.setEnabled("dep", true)
		assertNull(fx.manager.setEnabled("top", true))
		assertEquals(true, state("top").enabled)
		assertEquals(true, state("top").active)

		assertNull(fx.manager.setEnabled("top", false))
		assertEquals(false, state("top").enabled)
		assertEquals(false, state("top").active)
	}

	@Test
	fun statesReflectFlagAndLiveness() {
		val store = FakeStore("a")
		val fx = Fixture(
			manifests = mapOf("a" to manifest("a"), "b" to manifest("b")),
			catalog = listOf(PluginCatalog.Entry("a") {}, PluginCatalog.Entry("b") {}),
			store = store,
		)
		fx.manager.boot()
		val byId = fx.manager.states().associateBy { it.id }
		assertEquals(true, byId["a"]!!.enabled)
		assertEquals(true, byId["a"]!!.active)
		assertEquals("A", byId["a"]!!.displayName)
		assertEquals(false, byId["b"]!!.enabled)
		assertEquals(false, byId["b"]!!.active)
	}

	@Test
	fun disablingANotLoadedPluginStillClearsItsFlag() {
		val store = FakeStore("top")
		val fx = Fixture(
			manifests = mapOf("dep" to manifest("dep"), "top" to manifest("top", requires = listOf("dep"))),
			catalog = listOf(PluginCatalog.Entry("dep") {}, PluginCatalog.Entry("top") {}),
			store = store,
		)
		fx.manager.boot() // top skipped: dep off
		assertNull(fx.manager.setEnabled("top", false))
		assertEquals(false, store.flags["top"])
	}
}
