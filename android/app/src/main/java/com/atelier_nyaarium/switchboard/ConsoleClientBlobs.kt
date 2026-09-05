package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleBlobGetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBlobPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleBlobStatResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.File
import java.util.Base64


// The remote cursor is the contiguous resume point.
suspend fun ConsoleClient.blobStat(blobId: String, targetGateway: String? = null): ConsoleBlobStatResult =
	valueResult(sendValueOp(targetGateway ?: defaultGatewayId(), ConsoleOp.BlobStat(blobId = blobId)), Protocol.Wire.ConsoleOpKind.BLOB_STAT)

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

suspend fun ConsoleClient.blobGet(blobId: String, offset: Long, length: Int, fromGateway: String? = null): ConsoleBlobGetResult =
	valueResult(
		sendValueOp(
			defaultGatewayId(),
			ConsoleOp.BlobGet(blobId = blobId, offset = offset, length = length.toLong(), fromGateway = fromGateway),
		),
		Protocol.Wire.ConsoleOpKind.BLOB_GET,
	)

suspend fun ConsoleClient.uploadBlob(source: File, targetGateway: String? = null): String {
	val blobId = blobs.ingestFile(source)

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
		// A stalled remote cursor must fail instead of retrying forever.
		if (ack.have <= offset) error("blob $blobId stalled at offset $offset")
		offset = ack.have
	}
}

fun ConsoleClient.blobIdOf(source: File): String = blobs.ingestFile(source)

fun ConsoleClient.forgetBlob(blobId: String) {
	runCatching { blobs.remove(blobId) }
}

fun ConsoleClient.pruneStaleBlobs(maxAgeMs: Long): Long = runCatching { blobs.pruneStale(maxAgeMs) }.getOrDefault(0L)

class BlobAbsent(blobId: String) : Exception("blob $blobId exists on no machine")

suspend fun ConsoleClient.downloadBlob(blobId: String, fromGateway: String? = null): File {
	blobs.path(blobId)?.let { return it }

	var offset = blobs.stat(blobId).have
	while (true) {
		// Bound peer-controlled streams before writing.
		if (offset > Protocol.MAX_BLOB_BYTES) error("blob $blobId exceeded ${Protocol.MAX_BLOB_BYTES} bytes")
		val res = blobGet(blobId, offset, Protocol.BLOB_CHUNK_BYTES, fromGateway)
		val bytes = res.chunk?.let { Base64.getDecoder().decode(it) } ?: ByteArray(0)
		// Absence is terminal because every holder has answered.
		if (bytes.isEmpty() && res.absent == true) throw BlobAbsent(blobId)
		if (bytes.isEmpty() && !res.eof) error("blob $blobId stalled at offset $offset")
		val written = blobs.write(blobId, offset, bytes, res.eof)
		if (res.eof) {
			if (!written.complete) error("blob $blobId failed verification after download")
			return blobs.path(blobId) ?: error("blob $blobId sealed but has no path")
		}
		offset = written.have
	}
}
