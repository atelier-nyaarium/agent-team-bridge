package com.atelier_nyaarium.switchboard

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two rules that make the whole-file-in-memory bug unexpressible rather than merely unlikely.
 *
 * Both are structural claims about the source, so they are checked against the source. A unit test
 * over behavior cannot see a NEW call site that reintroduces the hazard, which is exactly the
 * failure mode being guarded: the previous fix hardened one call site and the next one crashed.
 */
class OutgoingFileResidueTest {
	private val mainSrc = File("src/main/java/com/atelier_nyaarium/switchboard")

	private fun sources(): List<File> =
		mainSrc.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

	@Test
	fun outgoingFileIsMintedOnlyByItsFactory() {
		// Both spellings. The constructor is private, but `OutgoingFile.of(...)` is an internal
		// companion member and therefore reachable from anywhere in the module, so matching only
		// `OutgoingFile(` checked the half the compiler already enforces and missed the half it does
		// not. Admission has to stay the one place a sendable file comes into existence, because it
		// is the only place that decides from a stat before anything proportional is allocated.
		val offenders = sources()
			.filter { it.name != "OutgoingFiles.kt" }
			.filter { Regex("""\bOutgoingFile(\(|\.of\b)""").containsMatchIn(it.readText()) }
			.map { it.name }
		assertEquals("OutgoingFile may only be minted by OutgoingFiles.admit", emptyList<String>(), offenders)
	}

	@Test
	fun theUiNeverLaunchesTheAttachmentPathOnItsOwnScope() {
		// A Compose scope carries no exception handler, so an Error escaping repository work reaches
		// the uncaught handler and kills the app. These are the calls that can move whole
		// attachments and therefore actually raise an Error; they must go through repo.command.
		//
		// Scoped deliberately rather than banning every scope.launch{repo.*}: the other repo calls
		// allocate nothing proportional to a file, and several of their launch bodies interleave UI
		// work that must stay on Main. Widening the Error boundary to all repository work is real
		// and worth doing, but it is a dispatcher change, not a find-and-replace.
		// Matched across the whole launch body, not just its first token: `\s*` cannot span a
		// statement, so the old form was evaded by any line appearing before the repo call - which is
		// exactly what a regression looks like, since nobody reintroduces this on line one. Any
		// `<something>.launch` counts; the scope does not have to be spelled `scope`.
		//
		// A file that builds its own CoroutineExceptionHandler is exempt, because that is precisely
		// the thing whose absence makes a launch dangerous. This is what the rule is really about: a
		// Compose `rememberCoroutineScope` has no handler and cannot be given one, so an Error
		// escaping repository work there reaches the uncaught handler and kills the app.
		val hazardous = listOf("retrySend", "send", "addDraftFiles", "scheduleSend", "reconcilePending")
		val offenders = sources()
			.filter { !it.readText().contains("CoroutineExceptionHandler") }
			.flatMap { f ->
				val text = f.readText()
				hazardous.filter { call ->
					Regex("""\w+\.launch(\([^)]*\))?\s*\{[^}]*\brepo\.$call\b""", RegexOption.DOT_MATCHES_ALL)
						.containsMatchIn(text)
				}.map { "${f.name}:$it" }
			}
		assertEquals("attachment-path calls must use repo.command { }", emptyList<String>(), offenders)
	}

	@Test
	fun theSendPathHoldsNoWholeFileByteArray() {
		// readBytes() on the send path is what the admission handle exists to prevent, and now that
		// the transport moves bytes a chunk at a time there is no exception left to allow: an
		// attachment reaches the wire without ever being whole in memory. A new call site is a
		// reintroduction of the crash, not a variation on it.
		val offenders = sources()
			.filter { Regex("""\breadBytes\(\)""").containsMatchIn(it.readText()) }
			.map { it.name }
		assertTrue("unexpected readBytes() on the attachment path: $offenders", offenders.isEmpty())
	}
}
