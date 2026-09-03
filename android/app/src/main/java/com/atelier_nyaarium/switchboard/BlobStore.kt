package com.atelier_nyaarium.switchboard

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** [have] is the contiguous prefix held from offset 0, which IS the resume cursor. */
data class BlobStat(val have: Long, val size: Long?, val complete: Boolean)

data class BlobWriteResult(val have: Long, val complete: Boolean)

data class BlobReadResult(val bytes: ByteArray, val eof: Boolean) {
	override fun equals(other: Any?): Boolean =
		this === other || (other is BlobReadResult && bytes.contentEquals(other.bytes) && eof == other.eof)

	override fun hashCode(): Int = 31 * bytes.contentHashCode() + eof.hashCode()
}

/** Plaintext store. Kotlin twin of blob-store.ts; shared fixtures enforce parity. */
class BlobStore(private val root: File) {
	fun stat(blobId: String): BlobStat {
		assertId(blobId)
		val final = finalPath(blobId)
		if (final.isFile) return BlobStat(final.length(), final.length(), true)
		val part = partPath(blobId)
		return BlobStat(if (part.isFile) part.length() else 0L, null, false)
	}

	/** Writes contiguous chunks. */
	fun write(blobId: String, offset: Long, chunk: ByteArray, final: Boolean): BlobWriteResult {
		assertId(blobId)
		val current = stat(blobId)
		if (current.complete) return BlobWriteResult(current.have, true)
		require(offset <= current.have) { "blob $blobId: chunk at $offset leaves a gap after ${current.have}" }

		val part = partPath(blobId)
		part.parentFile?.mkdirs()

		// Final retries must still seal.
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
		// Report the honest prefix.
		if (have < offset + chunk.size) return BlobWriteResult(have, false)
		return BlobWriteResult(have, seal(blobId))
	}

	/** Range read. */
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
		// Reads refresh staleness.
		file.setLastModified(System.currentTimeMillis())
		return BlobReadResult(out, offset + want >= size)
	}

	/** Complete, verified file only. */
	fun path(blobId: String): File? {
		assertId(blobId)
		return finalPath(blobId).takeIf { it.isFile }
	}

	/** Streams and hashes a file. */
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
		// Identical bytes are already stored.
		if (final.isFile) tmp.delete() else tmp.renameTo(final)
		return blobId
	}

	fun remove(blobId: String) {
		assertId(blobId)
		finalPath(blobId).delete()
		partPath(blobId).delete()
	}

	/** Deletes stale transfer residue. */
	fun pruneStale(maxAgeMs: Long, now: Long = System.currentTimeMillis()): Long {
		var freed = 0L
		val fanout = root.listFiles() ?: return 0L
		for (dir in fanout) {
			val files = if (dir.isDirectory) dir.listFiles() ?: emptyArray() else arrayOf(dir)
			for (file in files) {
				val touched = file.lastModified()
				// Preserve the I/O-failure sentinel.
				if (touched == 0L || now - touched < maxAgeMs) continue
				val size = file.length()
				if (file.delete()) freed += size
			}
			if (dir.isDirectory && dir.listFiles()?.isEmpty() == true) dir.delete()
		}
		return freed
	}

	/** Promotes only verified parts. */
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
		/** Canonical blob id shape. */
		private val BLOB_ID_RE = Regex("^sha256-[0-9a-f]{64}$")

		/** Derives a blob id. */
		fun blobIdFor(bytes: ByteArray): String =
			"sha256-" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

		fun isBlobId(value: String): Boolean = BLOB_ID_RE.matches(value)

		/** App-private blob root. */
		fun root(filesDir: File): File = File(filesDir, "blobs")
	}
}
