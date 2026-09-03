package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Protocol
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SealedBlobTest {
	private val key = ByteArray(32) { 6 }
	private val context = BlobSealContext("domain", "owner", 5, "blob-id")

	private fun frame(plaintext: ByteArray, index: Long, final: Boolean): ByteArray {
		val aad = Crypto.ContentAad(
			context.domainId,
			context.ownerSignPub,
			context.epoch,
			"blob\n${context.blobId}\n$index\n${if (final) 1 else 0}",
		)
		val envelope = Crypto.sealContent(plaintext, key, aad, ByteArray(BLOB_NONCE_BYTES) { index.toByte() })
		return Base64.getDecoder().decode(envelope.nonce) + Base64.getDecoder().decode(envelope.ciphertext)
	}

	@Test
	fun opensFramesSealedByCrypto() {
		val plaintext = "sealed blob".toByteArray()
		val opened = openSealedBlobRange(
			SealedBlobRange(frame(plaintext, 0, true), 0, plaintext.size.toLong(), context.epoch),
			0,
			plaintext.size.toLong(),
			key,
			context,
		)
		assertArrayEquals(plaintext, opened.first)
		assertEquals(true, opened.second)
	}

	@Test
	fun opensAndTrimsAcrossAChunkBoundary() {
		val plaintext = ByteArray(Protocol.BLOB_CHUNK_BYTES + 12) { if (it < Protocol.BLOB_CHUNK_BYTES) 2 else 3 }
		val frames = frame(plaintext.copyOfRange(0, Protocol.BLOB_CHUNK_BYTES), 0, false) +
			frame(plaintext.copyOfRange(Protocol.BLOB_CHUNK_BYTES, plaintext.size), 1, true)
		val opened = openSealedBlobRange(
			SealedBlobRange(frames, 0, plaintext.size.toLong(), context.epoch),
			Protocol.BLOB_CHUNK_BYTES - 4L,
			8,
			key,
			context,
		)
		assertArrayEquals(ByteArray(4) { 2 } + ByteArray(4) { 3 }, opened.first)
		assertEquals(false, opened.second)
	}

	@Test
	fun rejectsNonChunkAlignedRanges() {
		assertThrows(IllegalArgumentException::class.java) {
			openSealedBlobRange(SealedBlobRange(ByteArray(0), 1, 0, context.epoch), 1, 1, key, context)
		}
	}

	@Test
	fun rejectsTruncatedFrames() {
		val plaintext = "truncated".toByteArray()
		val truncated = frame(plaintext, 0, true).copyOf(frame(plaintext, 0, true).size - 1)
		assertThrows(IllegalArgumentException::class.java) {
			openSealedBlobRange(SealedBlobRange(truncated, 0, plaintext.size.toLong(), context.epoch), 0, plaintext.size.toLong(), key, context)
		}
	}

	@Test
	fun emptyBlobIsOneFinalFrame() {
		val sealed = frame(ByteArray(0), 0, true)
		assertEquals(BLOB_FRAME_OVERHEAD_BYTES, sealed.size)
		val opened = openSealedBlobRange(SealedBlobRange(sealed, 0, 0, context.epoch), 0, 0, key, context)
		assertArrayEquals(ByteArray(0), opened.first)
		assertEquals(true, opened.second)
	}
}
