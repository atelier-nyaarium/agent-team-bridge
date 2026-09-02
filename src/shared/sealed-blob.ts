import crypto from "node:crypto";
import { type ContentAad, openContent, sealContentWithNonce } from "./content-envelope.js";
import {
	BLOB_CHUNK_BYTES,
	BLOB_CIPHERTEXT_CHUNK_BYTES,
	BLOB_FRAME_OVERHEAD_BYTES,
	BLOB_NONCE_BYTES,
} from "./router-protocol.js";
import type { ContentEnvelope } from "./schemasContentKey.js";

export interface BlobSealContext {
	domainId: string;
	ownerSignPub: string;
	epoch: number;
	blobId: string;
}

export interface SealedBlobRange {
	bytes: Buffer;
	offset: number;
	size: number;
	epoch: number;
}

export function sealedBlobChunkCount(size: number): number {
	return Math.max(1, Math.ceil(size / BLOB_CHUNK_BYTES));
}

export function sealedBlobSize(size: number): number {
	return size + sealedBlobChunkCount(size) * BLOB_FRAME_OVERHEAD_BYTES;
}

export function blobChunkAad(context: BlobSealContext, index: number, final: boolean): ContentAad {
	return {
		domainId: context.domainId,
		ownerSignPub: context.ownerSignPub,
		epoch: context.epoch,
		kind: `blob\n${context.blobId}\n${index}\n${final ? 1 : 0}`,
	};
}

export function sealBlobChunk(
	plaintext: Buffer,
	key: Buffer,
	context: BlobSealContext,
	index: number,
	final: boolean,
	nonce: Buffer = crypto.randomBytes(BLOB_NONCE_BYTES),
): Buffer {
	const envelope = sealContentWithNonce(plaintext, key, blobChunkAad(context, index, final), nonce);
	return Buffer.concat([Buffer.from(envelope.nonce, "base64"), Buffer.from(envelope.ciphertext, "base64")]);
}

export function openBlobChunk(
	frame: Buffer,
	key: Buffer,
	context: BlobSealContext,
	index: number,
	final: boolean,
): Buffer {
	if (frame.length < BLOB_FRAME_OVERHEAD_BYTES) throw new Error("sealed blob frame is too short");
	const envelope: ContentEnvelope = {
		v: 1,
		epoch: context.epoch,
		nonce: frame.subarray(0, BLOB_NONCE_BYTES).toString("base64"),
		ciphertext: frame.subarray(BLOB_NONCE_BYTES).toString("base64"),
	};
	return openContent(envelope, key, blobChunkAad(context, index, final));
}

export function ciphertextRangeForPlaintext(offset: number, length: number, size: number) {
	const startIndex = Math.floor(Math.min(offset, size) / BLOB_CHUNK_BYTES);
	const end = Math.min(size, offset + length);
	const endIndex = end <= offset ? startIndex : Math.ceil(end / BLOB_CHUNK_BYTES);
	const count = Math.max(1, endIndex - startIndex);
	const ciphertextOffset = startIndex * BLOB_CIPHERTEXT_CHUNK_BYTES;
	let ciphertextLength = 0;
	for (let index = startIndex; index < startIndex + count && index < sealedBlobChunkCount(size); index++) {
		const plaintextLength = Math.max(0, Math.min(BLOB_CHUNK_BYTES, size - index * BLOB_CHUNK_BYTES));
		ciphertextLength += plaintextLength + BLOB_FRAME_OVERHEAD_BYTES;
	}
	return { startIndex, plaintextOffset: startIndex * BLOB_CHUNK_BYTES, ciphertextOffset, ciphertextLength };
}

export function openSealedBlobRange(
	range: SealedBlobRange,
	requestedOffset: number,
	requestedLength: number,
	key: Buffer,
	context: Omit<BlobSealContext, "epoch">,
): { bytes: Buffer; eof: boolean } {
	// Partial reads authenticate chunks; BlobStore verifies the whole plaintext only on finalization.
	const chunks: Buffer[] = [];
	let cursor = 0;
	let index = range.offset / BLOB_CHUNK_BYTES;
	if (!Number.isInteger(index)) throw new Error("sealed blob range is not chunk-aligned");
	while (cursor < range.bytes.length) {
		const plaintextLength = Math.max(0, Math.min(BLOB_CHUNK_BYTES, range.size - index * BLOB_CHUNK_BYTES));
		const frameLength = plaintextLength + BLOB_FRAME_OVERHEAD_BYTES;
		if (cursor + frameLength > range.bytes.length) throw new Error("sealed blob range is truncated");
		const final = index + 1 === sealedBlobChunkCount(range.size);
		chunks.push(
			openBlobChunk(
				range.bytes.subarray(cursor, cursor + frameLength),
				key,
				{ ...context, epoch: range.epoch },
				index,
				final,
			),
		);
		cursor += frameLength;
		index++;
	}
	const opened = Buffer.concat(chunks);
	const trimStart = requestedOffset - range.offset;
	const bytes = opened.subarray(trimStart, trimStart + requestedLength);
	return { bytes, eof: requestedOffset + bytes.length >= range.size };
}
