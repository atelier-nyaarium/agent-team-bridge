package com.atelier_nyaarium.switchboard.sandbox

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaCodec
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaFormat
import android.media.MediaMuxer
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.Draft
import com.atelier_nyaarium.switchboard.Message
import com.atelier_nyaarium.switchboard.MessageFile
import com.atelier_nyaarium.switchboard.OutgoingFile
import com.atelier_nyaarium.switchboard.PendingGoal
import com.atelier_nyaarium.switchboard.Team
import com.atelier_nyaarium.switchboard.board.BoardBlob
import com.atelier_nyaarium.switchboard.board.GatewayBoard
import com.atelier_nyaarium.switchboard.localFieldOrSelf
import com.atelier_nyaarium.switchboard.proto.BoardAttachment
import com.atelier_nyaarium.switchboard.proto.BoardEntry
import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.serialization.json.Json

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
	/** Two sessions: one carries every seeded surface, the second only exists so the tab row draws.
	 * Both carry a domainId, which is what lets the sessions board qualify a spawn target and so
	 * exercise the create-on-another-machine path rather than falling back to a bare name. */
	fun teams(): List<Team> = listOf(
		Team(
			name = SESSION,
			status = "online",
			mode = "channel",
			queueDepth = 0,
			kind = "loose",
			sessionLabel = "Sandbox",
			domainId = DOMAIN,
		),
		Team(
			name = SESSION_2,
			status = "online",
			mode = "channel",
			queueDepth = 0,
			kind = "loose",
			sessionLabel = "Second",
			domainId = DOMAIN,
		),
	)

	/** Three admitted machines for two with sessions, so the board's idle-Gateway section is reachable. */
	fun admittedGateways(): List<String> = listOf(GATEWAY, "parsing", "idle-box")

	fun threads(): Map<String, List<Message>> = mapOf(SESSION to buildThread())

	/** A draft holding enough images to overflow one row, plus a plain file, so the strip has both
	 * tile kinds, the expanded view has to wrap, and the tap target has somewhere to go. */
	fun drafts(): Map<String, Draft> {
		val picked = (1..7).map { pngFixture("shot-$it.png") } + textFixture()
		val staged = Attachments.storeOutgoing(filesDir, bucket = "draft-1", files = picked)
		// A real pick reads these off the content Uri, which a seeded draft never has. Only some
		// files carry one, matching a provider that names nothing usable for the rest.
		val locations = staged.take(2).mapNotNull { f -> f.src?.let { it to "Pictures" } }.toMap()
		return mapOf(SESSION to Draft(text = "", files = staged, locations = locations))
	}

	/** An armed goal so the dock draws with no gateway behind it, in its awaiting-reply phase. */
	fun goals(): Map<String, PendingGoal> = mapOf(
		SESSION_2 to PendingGoal(
			text = "Complete the plan",
			armedAt = System.currentTimeMillis(),
			sentAt = System.currentTimeMillis(),
		),
	)

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

		videoFixture()?.let { clip ->
			rows += Message(
				fromMe = false,
				text = "A video, whose tile cycles frames once they have been extracted.",
				at = now - 110_000,
				id = id++,
				files = attach("sandbox-video", listOf(clip)),
				from = SESSION,
				epoch = SANDBOX_EPOCH,
				seq = 23,
			)
		}

		// The snapshot declares what it is and which refs it backs, exactly as a sender stamps it, so
		// the sandbox exercises the real classification: the chip hides and the links open.
		rows += Message(
			fromMe = false,
			text = REF_BODY,
			at = now - 60_000,
			id = id++,
			files = attach("sandbox-refs", refArtifacts()).map { it.copy(role = "ref-snapshot", ref = refMeta()) },
			from = SESSION,
			epoch = SANDBOX_EPOCH,
			seq = 21,
		)

		// A card the console never opened to classify: declared, docked, and rendered from its own
		// fields, which is the byte-free ingest path the dock now takes. Titled, because this is the
		// thread's last inbound row and so the one the session card leads with.
		rows += Message(
			fromMe = false,
			title = "Docked a design card from its own fields",
			text = "A design card, docked from its declared fields.",
			at = now - 30_000,
			id = id++,
			files = attach("sandbox-card", listOf(cardFixture())).map {
				it.copy(role = "design-card", cardTitle = "Editor form", cardGroup = "Forms", cardWidth = 900, cardHeight = 1180)
			},
			from = SESSION,
			epoch = SANDBOX_EPOCH,
			seq = 22,
		)

		return rows
	}

	/** The ref block the snapshot declares: one exact resolution and one drifted, matching REF_BODY's
	 * two canonical keys, so the viewer's banner path renders alongside the clean one. */
	private fun refMeta(): RefFileMeta = RefFileMeta(
		refPath = "src/mcp/references/refFile.ts",
		segments = null,
		keys = listOf(
			RefKeyMeta(
				key = "ref://src/mcp/references/refFile.ts:isJoinable",
				startLine = 1,
				endLine = 12,
				quality = "exact",
			),
			RefKeyMeta(
				key = "ref://src/mcp/references/refFile.ts:LoaderV1:isJoinable",
				startLine = 1,
				endLine = 12,
				quality = "fuzzy",
				reason = "LoaderV1 no longer exists in this file",
			),
		),
	)

	/** Write fixture bytes into a real attachment bucket, so every src resolves the way a drained
	 * message's would. */
	private fun attach(bucket: String, files: List<OutgoingFile>): List<MessageFile> =
		Attachments.storeOutgoing(filesDir, bucket, files)

	/** The committed builder output: one role-stamped snapshot carrying the ref it backs. */
	private fun refArtifacts(): List<OutgoingFile> = listOf(staged("refFile.ts", "text/plain", asset("refFile.ts")))

	/** Bytes on disk under a scratch dir, because an OutgoingFile names a FILE the transport streams
	 * rather than a buffer it holds. Mirrors what a real pick or a staged artifact hands the sender. */
	private fun staged(name: String, mime: String, bytes: ByteArray): OutgoingFile {
		val scratch = File(filesDir, "sandbox-fixtures").apply { mkdirs() }
		val file = File(scratch, name).apply { writeBytes(bytes) }
		return OutgoingFile.of(name, mime, file.length(), file)
	}

	private fun asset(name: String): ByteArray = assets.open("sandbox/$name").use { it.readBytes() }

	/** Drawn rather than bundled: a binary in the tree would need a reason to exist, and any solid
	 * rectangle proves the thumbnail path just as well. */
	private fun pngFixture(name: String = "sandbox-image.png"): OutgoingFile {
		val bitmap = Bitmap.createBitmap(480, 320, Bitmap.Config.ARGB_8888)
		Canvas(bitmap).apply {
			drawColor(Color.parseColor("#1f6feb"))
			drawText(
				name.substringBefore('.'),
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
		return staged(name, "image/png", out.toByteArray())
	}

	/**
	 * A real, encodable clip, generated rather than bundled for the same reason the PNG is.
	 *
	 * Fed as YUV buffers rather than through an input Surface, which would need GL. Each second gets
	 * its own colour, so a thumbnail that cycles is obviously distinguishable from one that does not,
	 * which is the whole thing being looked at. Null when the device has no usable encoder: the
	 * sandbox then has no video row, rather than failing to start.
	 */
	private fun videoFixture(): OutgoingFile? = runCatching {
		val width = 320
		val height = 240
		val fps = 12
		val seconds = 40
		val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
			setInteger(MediaFormat.KEY_COLOR_FORMAT, CodecCapabilities.COLOR_FormatYUV420SemiPlanar)
			setInteger(MediaFormat.KEY_BIT_RATE, 500_000)
			setInteger(MediaFormat.KEY_FRAME_RATE, fps)
			// A sparse GOP on purpose: it is what makes a keyframe-snapping seek collapse every sample
			// onto one frame, which is the failure OPTION_CLOSEST exists to avoid.
			setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
		}
		val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
		codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
		codec.start()

		val scratch = File(filesDir, "sandbox-fixtures").apply { mkdirs() }
		val out = File(scratch, "clip.mp4")
		val muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
		val frame = ByteArray(width * height * 3 / 2)
		val info = MediaCodec.BufferInfo()
		var track = -1
		var muxing = false

		fun drain(endOfStream: Boolean) {
			while (true) {
				val index = codec.dequeueOutputBuffer(info, if (endOfStream) 10_000 else 0)
				if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
					if (!endOfStream) return
				} else if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
					track = muxer.addTrack(codec.outputFormat)
					muxer.start()
					muxing = true
				} else if (index >= 0) {
					val buffer = codec.getOutputBuffer(index)
					if (buffer != null && muxing && info.size > 0 &&
						info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0
					) {
						buffer.position(info.offset)
						buffer.limit(info.offset + info.size)
						muxer.writeSampleData(track, buffer, info)
					}
					codec.releaseOutputBuffer(index, false)
					if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
				}
			}
		}

		for (i in 0 until fps * seconds) {
			val index = codec.dequeueInputBuffer(10_000)
			if (index >= 0) {
				val second = i / fps
				// Luma ramps and chroma rotates, so consecutive sampled seconds never look alike.
				frame.fill((60 + (second * 17) % 160).toByte(), 0, width * height)
				val u = (80 + (second * 37) % 140).toByte()
				val v = (200 - (second * 23) % 140).toByte()
				var p = width * height
				while (p < frame.size) {
					frame[p] = u
					frame[p + 1] = v
					p += 2
				}
				codec.getInputBuffer(index)?.apply {
					clear()
					put(frame)
				}
				codec.queueInputBuffer(index, 0, frame.size, i * 1_000_000L / fps, 0)
			}
			drain(false)
		}
		val last = codec.dequeueInputBuffer(10_000)
		if (last >= 0) codec.queueInputBuffer(last, 0, 0, fps * seconds * 1_000_000L / fps, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
		drain(true)

		codec.stop()
		codec.release()
		if (muxing) muxer.stop()
		muxer.release()
		OutgoingFile.of("clip.mp4", "video/mp4", out.length(), out).takeIf { out.length() > 0 }
	}.getOrNull()

	private fun textFixture(): OutgoingFile =
		staged("notes.txt", "text/plain", "A plain attachment, so the non-image chip path renders too.\n".toByteArray())

	private fun cardFixture(): OutgoingFile = staged(
		"editor-form.html",
		"text/html",
		(
			"<!-- @dsCard group=\"Forms\" width=\"900\" height=\"1180\" -->\n" +
				"<html><head><title>Editor form</title></head>" +
				"<body style=\"background:#12151a;color:#e3e6ea;font-family:sans-serif;padding:24px\">" +
				"<h1>Editor form</h1><p>A sandbox canvas.</p></body></html>\n"
			).toByteArray(),
	)

	private companion object {
		/** domain.gateway.spawn.session, matching the real address grammar so nothing downstream has
		 * to special-case it. */
		const val SESSION = "local.sandbox.host.demo"

		/** A second session on a DIFFERENT gateway, since the thread's tab row is one tab per gateway. */
		const val SESSION_2 = "local.parsing.host.other"

		/** Must be the gateway segment of [SESSION]: `Team.gatewayId` derives from the address, and the
		 * thread strip looks the board up under whatever that answers. */
		const val GATEWAY = "sandbox"

		/** Must be the domain segment of both session addresses, or the board classifies them as a
		 * linked friend's and renders them in the peers section instead. */
		const val DOMAIN = "local"

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

	/**
	 * One board entry carrying attachments, which is the only way to look at the gallery.
	 *
	 * Both halves are seeded: the entry's metadata AND real bytes at the path the reader derives. The
	 * gallery's whole job is finding the second from the first, and the first version of it could not
	 * (it built a path shape the resolver rejects), which nothing but a screen or that seam's own test
	 * would show. One attachment is small enough to open on tap, one is over the auto-download
	 * threshold so its row asks to be tapped instead, and one names bytes that are simply absent.
	 */
	fun seedBoard(store: AppStateStore) {
		// A real id, not whatever a cleared install has: sourceGatewayIds drops empty ones, so a board
		// keyed by "" renders as an empty backlog with no hint that anything was seeded.
		val gatewayId = GATEWAY.also { store.saveGatewayId(it) }
		val entryId = "b".repeat(32)
		val present = writeBoardBytes(entryId, "shot", 4_000)
		val huge = BoardAttachment(
			blobId = "sha256-${"c".repeat(64)}",
			blobGateway = gatewayId,
			filename = "capture.bin",
			mime = "application/octet-stream",
			size = 340_000_000,
		)
		val missing = huge.copy(blobId = "sha256-${"d".repeat(64)}", filename = "gone.png", mime = "image/png", size = 900)

		// Held by the sandbox session, not the backlog, or the thread's board strip has no group to
		// match and renders as nothing at all.
		val entry = BoardEntry(
			id = entryId,
			title = "An entry with pictures",
			body = "Tap a row to open it. The big one waits to be asked.",
			state = "in_progress",
			rank = "m",
			sessionId = localFieldOrSelf(SESSION),
			attachments = listOf(present, huge, missing),
		)
		// A second root with children in all four states, ranked so its in-progress CHILD is the
		// session's current entry. That is what makes the card's branch walk visible: it has to climb to
		// this root and skip the attachments entry above it.
		val branch = listOf(
			BoardEntry(id = "c".repeat(32), title = "Half-finished example", state = "in_progress", rank = "zm", sessionId = localFieldOrSelf(SESSION)),
			BoardEntry(id = "d".repeat(32), title = "Child 1 - finished", state = "done", rank = "a", parent = "c".repeat(32), sessionId = localFieldOrSelf(SESSION)),
			BoardEntry(id = "e".repeat(32), title = "Child 2 - being worked on", state = "in_progress", rank = "b", parent = "c".repeat(32), sessionId = localFieldOrSelf(SESSION)),
			BoardEntry(id = "f".repeat(32), title = "Child 3 - dropped", state = "cancelled", rank = "c", parent = "c".repeat(32), sessionId = localFieldOrSelf(SESSION)),
			BoardEntry(id = "1".repeat(32), title = "Child 4 - not started", state = "open", rank = "d", parent = "c".repeat(32), sessionId = localFieldOrSelf(SESSION)),
		)
		val blob = BoardBlob(gateways = mapOf(gatewayId to GatewayBoard(entries = listOf(entry) + branch)))
		store.saveTaskBoard(Json { ignoreUnknownKeys = true }.encodeToString(BoardBlob.serializer(), blob))
	}

	/** Real bytes where the gallery will look for them, so a row can actually open. */
	private fun writeBoardBytes(entryId: String, label: String, bytes: Int): BoardAttachment {
		val png = ByteArrayOutputStream().also { out ->
			Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888).also { bmp ->
				Canvas(bmp).apply {
					drawColor(Color.parseColor("#2f6f4f"))
					drawText(label, 20f, 90f, Paint().apply { color = Color.WHITE; textSize = 34f })
				}
				bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
			}
		}.toByteArray()
		val blobId = "sha256-${"a".repeat(64)}"
		Attachments.boardFile(filesDir, entryId, blobId).also {
			it.parentFile?.mkdirs()
			it.writeBytes(png)
		}
		return BoardAttachment(blobId, "sandbox-gw", "$label.png", "image/png", png.size.toLong())
	}
}
