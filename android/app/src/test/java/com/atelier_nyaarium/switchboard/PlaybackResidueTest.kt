package com.atelier_nyaarium.switchboard

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The three rules that keep the playback lifecycle's recorded bug classes unexpressible rather than
 * merely fixed. Each is a claim about the SOURCE, because a behaviour test cannot see a new call site
 * that reintroduces the hazard - and a new call site is exactly how each of these recurred: nine
 * rounds of patches, every one of them correct where it landed.
 */
class PlaybackResidueTest {
	private val mainSrc = File("src/main/java/com/atelier_nyaarium/switchboard")

	private fun sourcesOutsideRegistry(): List<File> =
		mainSrc.walkTopDown()
			.filter { it.isFile && it.extension == "kt" && it.name != "PlaybackRequests.kt" }
			.toList()

	@Test
	fun playbackIdentityIsMintedOnlyByTheRegistry() {
		// Identity re-derived somewhere other than where it is owned is the class that produced the
		// preload collision: a second thing minting its own id is how two different concerns end up
		// sharing one key. The registry mints at claim and every hand-off carries the value.
		val offenders = sourcesOutsideRegistry()
			.filter { Regex("""\bPlaybackId\(""").containsMatchIn(it.readText()) }
			.map { it.name }
		assertEquals("PlaybackId may only be minted by PlaybackRequests.claim", emptyList<String>(), offenders)
	}

	@Test
	fun playbackEventsAreConstructedOnlyByTheRegistry() {
		// Delivery order is the registry's transition order because minting happens inside the same
		// critical section as the state change. An event built anywhere else was not minted under that
		// monitor, so it can arrive in an order no state transition ever had - which is precisely the
		// Started-after-its-own-Ended defect that a consumer then had to defend against.
		val offenders = sourcesOutsideRegistry()
			.filter { Regex("""Event\.(Started|Ended)\(""").containsMatchIn(it.readText()) }
			.map { it.name }
		assertEquals("playback events may only be minted by PlaybackRequests", emptyList<String>(), offenders)
	}

	@Test
	fun abandonHasNoDefaultForWhetherThePositionSurvives() {
		// A pause, a skip, a trash and a genuine displacement all end as PREEMPTED and do not agree
		// about the position: two keep it, two destroy it. Inferring from the outcome made
		// `forgetPosition` a no-op, re-filing the offset on the play lane one line after the delete.
		//
		// The ENFORCEMENT is the missing default: with none, a call site that says nothing does not
		// compile, which is exhaustive and has no pattern to evade. This asserts only that the default
		// is still absent, because the first version of this rule was a regex over call sites - and a
		// regex cannot tell "every call declares its intent" from "the pattern matched nothing", which
		// is the same vacuity it was written to prevent.
		val signature = File(mainSrc, "SttsPlayer.kt").readText()
			.lines()
			.first { it.contains("fun abandon(") }
		assertEquals(
			"abandon must not default `remember`; the compiler is what makes every caller declare it",
			true,
			signature.contains("remember: Boolean)") && !signature.contains("remember: Boolean ="),
		)
	}

	@Test
	fun theRegistryStaysFreeOfAndroid() {
		// Every defect in the effect layer was uncatchable because no JVM test can construct it. This
		// unit is testable only while it imports no platform type, and the pressure to break that is
		// ordinary and constant: the first instinct on losing a log line was to reach for the logger.
		val imports = File(mainSrc, "PlaybackRequests.kt").readText()
			.lines()
			.filter { it.startsWith("import android") || it.startsWith("import androidx") }
		assertEquals("PlaybackRequests must stay unit-testable, so it imports no platform type", emptyList<String>(), imports)
	}
}
