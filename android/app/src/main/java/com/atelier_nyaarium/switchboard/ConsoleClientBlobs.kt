package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleBlobGetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBlobPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBlobStatResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.File
import java.util.Base64

////////////////////////////////
//  Blob plane ops

/** How much of a blob the gateway already holds. `have` is the contiguous prefix, so it is also
 * the offset to resume from - no separate progress bookkeeping to get out of step. */
suspend fun ConsoleClient.blobStat(blobId: String, targetGateway: String? = null): ConsoleBlobStatResult =
	valueResult(sendValueOp(targetGateway ?: defaultGatewayId(), ConsoleOp.BlobStat(blobId = blobId)), Protocol.Wire.ConsoleOpKind.BLOB_STAT)

/** Send one bounded chunk. Re-sending an offset already held is a no-op at the store, because
 * the blob is named by its own digest, so a retry needs no idempotency key of its own.
 *
 * `targetGateway` is which Gateway the bytes must LAND on. A board attachment belongs to the
 * Gateway holding its entry, which is regularly not this device's home Gateway; without it the
 * metadata would name bytes only another machine holds. */
suspend fun ConsoleClient.blobPut(
	blobId: String,
	offset: Long,
	chunk: ByteArray,
	final: Boolean,
	targetGateway: String? = null,
): ConsoleBlobPutResult = valueResult(
		sendValueOp(targetGateway ?: defaultGatewayId(), ConsoleOp.BlobPut(
			blobId = blobId,
			offset = offset,
			chunk = Base64.getEncoder().encodeToString(chunk),
			final = final,
		)),
		Protocol.Wire.ConsoleOpKind.BLOB_PUT,
	)

/** Read one bounded range back. */
/** `fromGateway` names the Gateway holding the bytes. */
suspend fun ConsoleClient.blobGet(blobId: String, offset: Long, length: Int, fromGateway: String? = null): ConsoleBlobGetResult =
	valueResult(
		sendValueOp(
			defaultGatewayId(),
			ConsoleOp.BlobGet(blobId = blobId, offset = offset, length = length.toLong(), fromGateway = fromGateway),
		),
		Protocol.Wire.ConsoleOpKind.BLOB_GET,
	)

/**
 * Put a local file's bytes on the Gateway and return the reference that names them.
 *
 * A chunk at a time in both hops, so neither this process nor a transport frame ever holds the whole
 * file. `have` from each write is the resume cursor, so a transfer interrupted by a dropped
 * connection continues instead of restarting, and a re-sent chunk is free because a blob is named
 * by its own digest.
 */
suspend fun ConsoleClient.uploadBlob(source: File, targetGateway: String? = null): String {
	val blobId = blobs.ingestFile(source)

	// Skip anything the Gateway already holds: a resend, or the same file from another device.
	val remote = blobStat(blobId, targetGateway)
	if (remote.complete) return blobId

	var offset = remote.have
	val total = blobs.stat(blobId).have
	while (true) {
		val read = blobs.read(blobId, offset, Protocol.BLOB_CHUNK_BYTES)
		val final = read.eof || offset + read.bytes.size >= total
		val ack = blobPut(blobId, offset, read.bytes, final, targetGateway)
		if (final) {
			if (!ack.complete) error("blob $blobId failed verification at the Gateway")
			return blobId
		}
		// The Gateway's cursor beats our own arithmetic: it is the side that knows what landed. But
		// a cursor that does not move means the chunk did not land, and re-sending it forever would
		// spin on metered data rather than fail, so a stalled transfer becomes a visible error.
		if (ack.have <= offset) error("blob $blobId stalled at offset $offset")
		offset = ack.have
	}
}

/** Stage a local file and return the name its bytes will have. Lets a caller record the blobId
 * alongside its own metadata before any transfer starts, since the name IS the digest. */
fun ConsoleClient.blobIdOf(source: File): String = blobs.ingestFile(source)

/** Drop a staged blob once its bytes are safely somewhere durable. The store is a transfer
 * buffer on this device, so keeping a landed blob would mean holding every attachment twice. */
fun ConsoleClient.forgetBlob(blobId: String) {
	runCatching { blobs.remove(blobId) }
}

/** Reclaim transfer residue: an abandoned upload, a fetch whose row vanished, a torn `.part`. */
fun ConsoleClient.pruneStaleBlobs(maxAgeMs: Long): Long = runCatching { blobs.pruneStale(maxAgeMs) }.getOrDefault(0L)

/**
 * Pull a blob's bytes down and return the local file holding them.
 *
 * Resumes from whatever this device already has, and returns immediately for one it holds in
 * full. The store seal-verifies the digest, so a truncated or tampered transfer yields no file
 * at all rather than a subtly wrong one.
 */
/** The Gateway PROVED the bytes exist nowhere (every named holder answered and had nothing), so a
 * retry can never succeed. Its own type because callers act on it: an ordinary stall retries. */
class BlobAbsent(blobId: String) : Exception("blob $blobId exists on no machine")

suspend fun ConsoleClient.downloadBlob(blobId: String, fromGateway: String? = null): File {
	blobs.path(blobId)?.let { return it }

	var offset = blobs.stat(blobId).have
	while (true) {
		// The far side decides when a transfer ends, so a peer that never sets eof would otherwise
		// stream onto the phone's storage until it filled. Nothing legitimate crosses the ceiling.
		if (offset > Protocol.MAX_BLOB_BYTES) error("blob $blobId exceeded ${Protocol.MAX_BLOB_BYTES} bytes")
		val res = blobGet(blobId, offset, Protocol.BLOB_CHUNK_BYTES, fromGateway)
		val bytes = res.chunk?.let { Base64.getDecoder().decode(it) } ?: ByteArray(0)
		if (bytes.isEmpty() && res.absent == true) throw BlobAbsent(blobId)
		// A short read that is not the end would otherwise spin here asking for the same offset.
		if (bytes.isEmpty() && !res.eof) error("blob $blobId stalled at offset $offset")
		val written = blobs.write(blobId, offset, bytes, res.eof)
		if (res.eof) {
			if (!written.complete) error("blob $blobId failed verification after download")
			return blobs.path(blobId) ?: error("blob $blobId sealed but has no path")
		}
		offset = written.have
	}
}
