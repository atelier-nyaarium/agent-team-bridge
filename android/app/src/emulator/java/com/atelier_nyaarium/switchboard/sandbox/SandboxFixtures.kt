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

	/** Canned listings for the create dialog's directory picker, keyed by the listed prefix (the
	 * text up to and including its last "/"). Enough shape to see descent, filtering, and the
	 * greyed dot dirs. */
	fun dirs(): Map<String, List<String>> = mapOf(
		"~/" to listOf(".config", ".local", "Desktop", "Documents", "Downloads", "Music", "Pictures", "plans", "projects", "Videos"),
		"~/projects/" to listOf("evie-bot", "nyaaskills", "recipe-app", "story-designer", "switchboard"),
		"~/Downloads/" to listOf("media"),
		"~/.config/" to listOf("nvim", "systemd"),
	)

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
				// Inbound rows need real journal coordinates or countsUnread() is false for every row
				// and the unread/divider machinery never engages at all here.
				epoch = if (i % 3 == 0) 0L else SANDBOX_EPOCH,
				seq = if (i % 3 == 0) 0L else i.toLong(),
			)
		}

		rows += Message(
			fromMe = false,
			text = "An image and a plain file, so both chip paths render.",
			at = now - 120_000,
			id = id++,
			files = attach("sandbox-media", listOf(pngFixture(), textFixture())),
			from = SESSION,
			epoch = SANDBOX_EPOCH,
			seq = 20,
		)

		rows += Message(
			fromMe = false,
			text = REF_BODY,
			at = now - 60_000,
			id = id++,
			files = attach("sandbox-refs", refArtifacts()),
			from = SESSION,
			epoch = SANDBOX_EPOCH,
			seq = 21,
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

		/** A stable non-zero mailbox epoch for the seeded rows: countsUnread() needs seq > 0, and
		 * the anchor resolves by (epoch, seq) equality, so both must be real values here. */
		const val SANDBOX_EPOCH = 7L

		/**
		 * The link destinations MUST match the keys in the committed manifest, or the tap declines and
		 * the fixture silently proves nothing.
		 *
		 * Labels follow the `file : symbol` rule the references plugin teaches, which is also what
		 * exercises the chip's two-weight split. The third link deliberately does NOT, so the
		 * leave-it-alone path is on screen beside the split one.
		 */
		val REF_BODY = """
			Two refs into this repo. One resolves exactly, one has drifted.

			Exact, a small function: [refFile.ts : isJoinable](ref://src/mcp/references/refFile.ts:isJoinable)

			Drifted, naming a scope that no longer exists: [refFile.ts : LoaderV1](ref://src/mcp/references/refFile.ts:LoaderV1:isJoinable)

			A label that does not follow the rule is left exactly as written: [the joinability check](ref://src/mcp/references/refFile.ts:isJoinable)
		""".trimIndent()
	}
}
