package com.atelier_nyaarium.switchboard

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

////////////////////////////////
//  Interfaces & Types

/** [have] is the contiguous prefix held from offset 0, which IS the resume cursor. */
data class BlobStat(val have: Long, val size: Long?, val complete: Boolean)

data class BlobWriteResult(val have: Long, val complete: Boolean)

data class BlobReadResult(val bytes: ByteArray, val eof: Boolean) {
	override fun equals(other: Any?): Boolean =
		this === other || (other is BlobReadResult && bytes.contentEquals(other.bytes) && eof == other.eof)

	override fun hashCode(): Int = 31 * bytes.contentHashCode() + eof.hashCode()
}

////////////////////////////////
//  Functions & Helpers

/**
 * Content-addressed byte store. The Kotlin twin of `src/shared/blob-store.ts`, held equivalent by
 * the shared corpus at `tests/fixtures/blob/_manifest.json` that both runtimes iterate.
 *
 * A blob is named by the digest of its own contents, so the name is its identity, its dedup key,
 * its resume key, and its integrity check at once. Nothing here accepts or returns a whole file:
 * writes are bounded chunks at an offset and reads are bounded ranges, so "hold this entire
 * attachment in memory" is not an expression a caller can write.
 */
class BlobStore(private val root: File) {
	fun stat(blobId: String): BlobStat {
		assertId(blobId)
		val final = finalPath(blobId)
		if (final.isFile) return BlobStat(final.length(), final.length(), true)
		val part = partPath(blobId)
		return BlobStat(if (part.isFile) part.length() else 0L, null, false)
	}

	/**
	 * Write one chunk at [offset]. A gap is refused, because a hole is something neither `have` nor
	 * the digest can describe. Re-writing bytes already held is a no-op, which is what makes a
	 * retried chunk free rather than an error.
	 */
	fun write(blobId: String, offset: Long, chunk: ByteArray, final: Boolean): BlobWriteResult {
		assertId(blobId)
		val current = stat(blobId)
		if (current.complete) return BlobWriteResult(current.have, true)
		require(offset <= current.have) { "blob $blobId: chunk at $offset leaves a gap after ${current.have}" }

		val part = partPath(blobId)
		part.parentFile?.mkdirs()

		// Adds nothing past the prefix: the sender retried. Still falls through when `final` is set,
		// or a fully-retried last chunk (and an empty blob) would never seal.
		val covered = offset + chunk.size <= current.have
		if (!covered || !part.isFile) {
			RandomAccessFile(part, "rw").use { raf ->
				val skip = (current.have - offset).toInt()
				if (chunk.size > skip) {
					raf.seek(current.have)
					raf.write(chunk, skip, chunk.size - skip)
				}
			}
		}

		val have = if (part.isFile) part.length() else 0L
		if (!final) return BlobWriteResult(have, false)
		// A short write leaves the part shorter than the chunk that just claimed to finish it, which
		// is what a disk filling mid-write looks like. Sealing would hash a truncated file, fail the
		// digest, and DESTROY the whole transfer to punish a lost tail. Report the honest prefix and
		// let the sender resume from it.
		if (have < offset + chunk.size) return BlobWriteResult(have, false)
		return BlobWriteResult(have, seal(blobId))
	}

	/** Range read. Never the whole blob unless a caller asks for it a chunk at a time. */
	fun read(blobId: String, offset: Long, length: Int): BlobReadResult {
		assertId(blobId)
		val file = path(blobId) ?: throw IllegalStateException("blob $blobId is not complete")
		val size = file.length()
		if (offset >= size) return BlobReadResult(ByteArray(0), true)
		val want = minOf(length.toLong(), size - offset).toInt()
		val out = ByteArray(want)
		RandomAccessFile(file, "r").use { raf ->
			raf.seek(offset)
			raf.readFully(out)
		}
		// Reading marks a blob as recently used, which is what makes pruneStale's age test mean
		// "untouched" rather than "written a while ago". Without it, a blob being read right now
		// ages out on the same schedule as one nobody has looked at since it arrived.
		file.setLastModified(System.currentTimeMillis())
		return BlobReadResult(out, offset + want >= size)
	}

	/** The file, ONLY when complete and verified, so a torn transfer can never reach a decoder. */
	fun path(blobId: String): File? {
		assertId(blobId)
		return finalPath(blobId).takeIf { it.isFile }
	}

	/** Stream a local file into the store, hashing as it goes, and return the blob's own name. */
	fun ingestFile(source: File): String {
		val digest = MessageDigest.getInstance("SHA-256")
		root.mkdirs()
		val tmp = File(root, ".ingest-${java.util.UUID.randomUUID()}")
		source.inputStream().use { input ->
			tmp.outputStream().use { out ->
				val buf = ByteArray(1 shl 20)
				while (true) {
					val n = input.read(buf)
					if (n <= 0) break
					digest.update(buf, 0, n)
					out.write(buf, 0, n)
				}
			}
		}
		val blobId = "sha256-" + digest.digest().joinToString("") { "%02x".format(it) }
		val final = finalPath(blobId)
		final.parentFile?.mkdirs()
		// Present already means the identical bytes are stored; dedup is free.
		if (final.isFile) tmp.delete() else tmp.renameTo(final)
		return blobId
	}

	fun remove(blobId: String) {
		assertId(blobId)
		finalPath(blobId).delete()
		partPath(blobId).delete()
	}

	/**
	 * Delete anything under the root untouched for [maxAgeMs], and return the bytes freed.
	 *
	 * On this device the store is a transfer BUFFER, not a library: an inbound blob is dropped the
	 * moment its bytes are safely in the attachments bucket, and an outbound one has served its
	 * purpose once the send lands. What this reclaims is the residue neither path gets to - an
	 * upload abandoned mid-flight, a fetch whose row vanished, a `.part` from a killed process.
	 * Content addressing makes it safe to be wrong: anything swept can be fetched again by name.
	 */
	fun pruneStale(maxAgeMs: Long, now: Long = System.currentTimeMillis()): Long {
		var freed = 0L
		val fanout = root.listFiles() ?: return 0L
		for (dir in fanout) {
			val files = if (dir.isDirectory) dir.listFiles() ?: emptyArray() else arrayOf(dir)
			for (file in files) {
				val touched = file.lastModified()
				// 0L is lastModified's I/O-failure sentinel, not a 1970 timestamp. Leave it alone
				// rather than treat "age unknown" as "infinitely old".
				if (touched == 0L || now - touched < maxAgeMs) continue
				val size = file.length()
				if (file.delete()) freed += size
			}
			if (dir.isDirectory && dir.listFiles()?.isEmpty() == true) dir.delete()
		}
		return freed
	}

	/** Promote a finished `.part` only if its bytes hash to the name it claims; destroy it if not,
	 * so a corrupt transfer is invisible rather than subtly wrong. */
	private fun seal(blobId: String): Boolean {
		val part = partPath(blobId)
		val digest = MessageDigest.getInstance("SHA-256")
		part.inputStream().use { input ->
			val buf = ByteArray(1 shl 20)
			while (true) {
				val n = input.read(buf)
				if (n <= 0) break
				digest.update(buf, 0, n)
			}
		}
		val actual = "sha256-" + digest.digest().joinToString("") { "%02x".format(it) }
		if (actual != blobId) {
			part.delete()
			return false
		}
		return part.renameTo(finalPath(blobId))
	}

	private fun assertId(blobId: String) {
		require(BLOB_ID_RE.matches(blobId)) { "not a blob id: $blobId" }
	}

	private fun finalPath(blobId: String): File {
		val hex = blobId.removePrefix("sha256-")
		return File(File(root, hex.substring(0, 2)), hex)
	}

	private fun partPath(blobId: String): File = File(finalPath(blobId).path + ".part")

	companion object {
		/** `sha256-` plus 64 lowercase hex. The only shape a blob may be named. */
		private val BLOB_ID_RE = Regex("^sha256-[0-9a-f]{64}$")

		/** The name a blob will have, derived from its bytes. */
		fun blobIdFor(bytes: ByteArray): String =
			"sha256-" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

		fun isBlobId(value: String): Boolean = BLOB_ID_RE.matches(value)

		/** Where blobs live on the console: app-private, beside the attachments root. */
		fun root(filesDir: File): File = File(filesDir, "blobs")
	}
}
