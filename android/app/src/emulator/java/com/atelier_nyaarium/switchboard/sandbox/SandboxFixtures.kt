package com.atelier_nyaarium.switchboard.sandbox

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import com.atelier_nyaarium.switchboard.OutgoingFile
import com.atelier_nyaarium.switchboard.Team
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The canned board and threads the sandbox opens into.
 *
 * SCAFFOLDING. Add, change, or delete any of this freely. It is chosen to cover the surfaces that
 * could not be inspected without a screen, nothing more:
 *
 *  - a reference message with REAL artifacts, so claimed-link styling and the code viewer both work
 *  - an `exact` ref beside a `fuzzy` one, which render as two different colours
 *  - an image attachment, whose thumbnail is indistinguishable from a missing chip when its bytes
 *    are gone
 *  - a plain file chip, the non-image path
 *  - enough rows to scroll, for the read pointer and the unread divider
 *
 * The ref artifacts under `assets/sandbox/` are REAL builder output, not hand-written JSON, so the
 * viewer is exercised against the same bytes an agent would send. Regenerate them by running the
 * reference builder over this repo and overwriting both files; they will drift from the builder
 * eventually, and that is fine for a sandbox.
 */
class SandboxFixtures(private val filesDir: File, private val assets: AssetManager) {
	/** One session, enough for the board to render tiles instead of onboarding. */
	fun teams(): List<Team> = listOf(
		Team(
			name = SESSION,
			status = "online",
			mode = "channel",
			queueDepth = 0,
			kind = "loose",
			sessionLabel = "Sandbox",
			description = "Canned state, no gateway",
		),
	)

	fun threads(): Map<String, List<Message>> = mapOf(SESSION to buildThread())

	private fun buildThread(): List<Message> {
		val now = System.currentTimeMillis()
		val rows = mutableListOf<Message>()
		var id = 0L

		// Filler first, so the ref row is below the fold and the open-snap has somewhere to scroll.
		for (i in 1..12) {
			rows += Message(
				fromMe = i % 3 == 0,
				text = "Filler row $i. Here to give the read pointer and the unread divider something to move through.",
				at = now - (60_000L * (30 - i)),
				id = id++,
			)
		}

		rows += Message(
			fromMe = false,
			text = "An image and a plain file, so both chip paths render.",
			at = now - 120_000,
			id = id++,
			files = attach("sandbox-media", listOf(pngFixture(), textFixture())),
			from = SESSION,
		)

		rows += Message(
			fromMe = false,
			text = REF_BODY,
			at = now - 60_000,
			id = id++,
			files = attach("sandbox-refs", refArtifacts()),
			from = SESSION,
		)

		return rows
	}

	/** Write fixture bytes into a real attachment bucket, so every src resolves the way a drained
	 * message's would. */
	private fun attach(bucket: String, files: List<OutgoingFile>): List<MessageFile> =
		Attachments.storeOutgoing(filesDir, bucket, files)

	/** The committed builder output: the manifest first, then every snapshot it names. */
	private fun refArtifacts(): List<OutgoingFile> = listOf(
		OutgoingFile("switchboard-references.json", "application/json", asset("switchboard-references.json")),
		OutgoingFile("refFile.ts", "text/plain", asset("refFile.ts")),
	)

	private fun asset(name: String): ByteArray = assets.open("sandbox/$name").use { it.readBytes() }

	/** Drawn rather than bundled: a binary in the tree would need a reason to exist, and any solid
	 * rectangle proves the thumbnail path just as well. */
	private fun pngFixture(): OutgoingFile {
		val bitmap = Bitmap.createBitmap(480, 320, Bitmap.Config.ARGB_8888)
		Canvas(bitmap).apply {
			drawColor(Color.parseColor("#1f6feb"))
			drawText(
				"sandbox",
				24f,
				170f,
				Paint().apply {
					color = Color.WHITE
					textSize = 48f
					isAntiAlias = true
				},
			)
		}
		val out = ByteArrayOutputStream()
		bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
		bitmap.recycle()
		return OutgoingFile("sandbox-image.png", "image/png", out.toByteArray())
	}

	private fun textFixture(): OutgoingFile =
		OutgoingFile(
			"notes.txt",
			"text/plain",
			"A plain attachment, so the non-image chip path renders too.\n".toByteArray(),
		)

	private companion object {
		/** domain.gateway.spawn.session, matching the real address grammar so nothing downstream has
		 * to special-case it. */
		const val SESSION = "local.sandbox.host.demo"

		/** The link destinations MUST match the keys in the committed manifest, or the tap declines
		 * and the fixture silently proves nothing. */
		val REF_BODY = """
			Two refs into this repo. One resolves exactly, one has drifted.

			Exact, a small function: [isJoinable](ref://src/mcp/references/refFile.ts:isJoinable)

			Drifted, naming a scope that no longer exists: [a renamed scope](ref://src/mcp/references/refFile.ts:LoaderV1:isJoinable)
		""".trimIndent()
	}
}
