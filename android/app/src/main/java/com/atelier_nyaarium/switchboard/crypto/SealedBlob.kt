package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.util.Base64
import kotlin.math.ceil
import kotlin.math.floor

const val BLOB_NONCE_BYTES = 12
const val BLOB_TAG_BYTES = 16
const val BLOB_FRAME_OVERHEAD_BYTES = BLOB_NONCE_BYTES + BLOB_TAG_BYTES
const val BLOB_CIPHERTEXT_CHUNK_BYTES = Protocol.BLOB_CHUNK_BYTES + BLOB_FRAME_OVERHEAD_BYTES

data class BlobSealContext(
	val domainId: String,
	val ownerSignPub: String,
	val epoch: Int,
	val blobId: String,
)

data class SealedBlobRange(
	val bytes: ByteArray,
	val offset: Long,
	val size: Long,
	val epoch: Int,
)

data class CiphertextRange(
	val startIndex: Long,
	val plaintextOffset: Long,
	val ciphertextOffset: Long,
	val ciphertextLength: Long,
)

fun sealedBlobChunkCount(size: Long): Long = maxOf(1L, ceil(size.toDouble() / Protocol.BLOB_CHUNK_BYTES).toLong())

fun sealedBlobSize(size: Long): Long = size + sealedBlobChunkCount(size) * BLOB_FRAME_OVERHEAD_BYTES

fun blobChunkAad(context: BlobSealContext, index: Long, final: Boolean): Crypto.ContentAad =
	Crypto.ContentAad(
		context.domainId,
		context.ownerSignPub,
		context.epoch,
		"blob\n${context.blobId}\n$index\n${if (final) 1 else 0}",
	)

fun openBlobChunk(
	frame: ByteArray,
	key: ByteArray,
	context: BlobSealContext,
	index: Long,
	final: Boolean,
): ByteArray {
	if (frame.size < BLOB_FRAME_OVERHEAD_BYTES) throw IllegalArgumentException("sealed blob frame is too short")
	val envelope = ContentEnvelope(
		v = 1L,
		epoch = context.epoch.toLong(),
		nonce = Base64.getEncoder().encodeToString(frame.copyOfRange(0, BLOB_NONCE_BYTES)),
		ciphertext = Base64.getEncoder().encodeToString(frame.copyOfRange(BLOB_NONCE_BYTES, frame.size)),
	)
	return Crypto.openContent(envelope, key, blobChunkAad(context, index, final))
}

fun ciphertextRangeForPlaintext(offset: Long, length: Long, size: Long): CiphertextRange {
	val startIndex = floor(minOf(offset, size).toDouble() / Protocol.BLOB_CHUNK_BYTES).toLong()
	val end = minOf(size, offset + length)
	val endIndex = if (end <= offset) startIndex else ceil(end.toDouble() / Protocol.BLOB_CHUNK_BYTES).toLong()
	val count = maxOf(1L, endIndex - startIndex)
	var ciphertextLength = 0L
	for (index in startIndex until (startIndex + count)) {
		if (index >= sealedBlobChunkCount(size)) break
		val plaintextLength = maxOf(0L, minOf(Protocol.BLOB_CHUNK_BYTES.toLong(), size - index * Protocol.BLOB_CHUNK_BYTES))
		ciphertextLength += plaintextLength + BLOB_FRAME_OVERHEAD_BYTES
	}
	return CiphertextRange(
		startIndex = startIndex,
		plaintextOffset = startIndex * Protocol.BLOB_CHUNK_BYTES,
		ciphertextOffset = startIndex * BLOB_CIPHERTEXT_CHUNK_BYTES,
		ciphertextLength = ciphertextLength,
	)
}

fun openSealedBlobRange(
	range: SealedBlobRange,
	requestedOffset: Long,
	requestedLength: Long,
	key: ByteArray,
	context: BlobSealContext,
): Pair<ByteArray, Boolean> {
	if (range.offset % Protocol.BLOB_CHUNK_BYTES != 0L) throw IllegalArgumentException("sealed blob range is not chunk-aligned")
	val chunks = ArrayList<ByteArray>()
	var cursor = 0
	var index = range.offset / Protocol.BLOB_CHUNK_BYTES
	while (cursor < range.bytes.size) {
		val plaintextLength = maxOf(0L, minOf(Protocol.BLOB_CHUNK_BYTES.toLong(), range.size - index * Protocol.BLOB_CHUNK_BYTES))
		// Fixed stride. Final chunk may be short.
		val frameLength = plaintextLength + BLOB_FRAME_OVERHEAD_BYTES
		if (frameLength > Int.MAX_VALUE || cursor.toLong() + frameLength > range.bytes.size) {
			throw IllegalArgumentException("sealed blob range is truncated")
		}
		val final = index + 1L == sealedBlobChunkCount(range.size)
		chunks += openBlobChunk(
			range.bytes.copyOfRange(cursor, cursor + frameLength.toInt()),
			key,
			context.copy(epoch = range.epoch),
			index,
			final,
		)
		cursor += frameLength.toInt()
		index++
	}
	val opened = ByteArray(chunks.sumOf { it.size })
	var destination = 0
	for (chunk in chunks) {
		chunk.copyInto(opened, destination)
		destination += chunk.size
	}
	val trimStart = requestedOffset - range.offset
	val start = trimStart.coerceIn(0L, opened.size.toLong()).toInt()
	val end = (trimStart + requestedLength).coerceIn(start.toLong(), opened.size.toLong()).toInt()
	val bytes = opened.copyOfRange(start, end)
	return bytes to (requestedOffset + bytes.size >= range.size)
}

fun openSealedBlobRange(
	bytes: ByteArray,
	offset: Long,
	size: Long,
	epoch: Int,
	requestedOffset: Long,
	requestedLength: Long,
	key: ByteArray,
	domainId: String,
	ownerSignPub: String,
	blobId: String,
): Pair<ByteArray, Boolean> = openSealedBlobRange(
	SealedBlobRange(bytes, offset, size, epoch),
	requestedOffset,
	requestedLength,
	key,
	BlobSealContext(domainId, ownerSignPub, epoch, blobId),
)
