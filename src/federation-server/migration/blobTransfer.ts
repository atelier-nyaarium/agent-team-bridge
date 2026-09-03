import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseBlobReference } from "../../shared/blob-reference.js";
import { isBlobId } from "../../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, BLOB_FRAME_OVERHEAD_BYTES } from "../../shared/router-protocol.js";
import type { MigrationBlob, MigrationExport } from "../../shared/schemasMigration.js";
import type { ReferenceHeldStore } from "../blobs/referenceHeldStore.js";

export function validateBlobArtifacts(dir: string, manifest: readonly MigrationBlob[]): string[] {
	const errors: string[] = [];
	const blobsDir = path.join(dir, "blobs");
	if (fs.existsSync(blobsDir) && fs.lstatSync(blobsDir).isSymbolicLink()) return ["blobs: symlink"];
	for (const item of manifest) {
		if (!isBlobId(item.blobId)) {
			errors.push(`${item.blobId}: invalid id`);
			continue;
		}
		const file = path.join(dir, "blobs", item.blobId);
		if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
			errors.push(`${item.blobId}: missing`);
			continue;
		}
		const bytes = fs.readFileSync(file);
		if (bytes.length !== sealedBlobSize(item.size)) errors.push(`${item.blobId}: size`);
		if (createHash("sha256").update(bytes).digest("hex") !== item.ciphertextDigest)
			errors.push(`${item.blobId}: digest`);
	}
	return errors;
}

export function importBlobArtifacts(
	dir: string,
	store: ReferenceHeldStore,
	snapshot: MigrationExport,
	manifest: readonly MigrationBlob[],
	references?: ReadonlyMap<string, readonly string[]>,
): void {
	const errors = validateBlobArtifacts(dir, manifest);
	if (errors.length) throw new Error(`blob verification failed: ${errors.join(", ")}`);
	for (const item of manifest) {
		if (references && !references.get(item.blobId)?.length) continue;
		const bytes = fs.readFileSync(path.join(dir, "blobs", item.blobId));
		const begin = store.begin(snapshot.domainId, item.blobId, item.size, bytes.length, item.ciphertextDigest, 1);
		if (begin.kind === "exists") continue;
		if (begin.kind !== "lease") throw new Error(`blob ${item.blobId}: ${begin.kind}`);
		for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES + BLOB_FRAME_OVERHEAD_BYTES) {
			const index = Math.floor(offset / (BLOB_CHUNK_BYTES + BLOB_FRAME_OVERHEAD_BYTES));
			const plaintextSize = Math.min(BLOB_CHUNK_BYTES, item.size - index * BLOB_CHUNK_BYTES);
			const frameSize = plaintextSize + BLOB_FRAME_OVERHEAD_BYTES;
			const frame = bytes.subarray(offset, offset + frameSize);
			const result = store.commitChunk(
				snapshot.domainId,
				item.blobId,
				begin.lease,
				offset,
				frame,
				index + 1 === blobChunkCount(item.size),
			);
			if ("kind" in result) throw new Error(`blob ${item.blobId}: ${result.kind}`);
		}
	}
	const refs = manifest.flatMap((item) =>
		(references?.get(item.blobId) ?? item.referencedBy).map((value) => {
			const ref = parseBlobReference(value);
			if (!ref) throw new Error(`invalid blob reference: ${value}`);
			return { ref, blobIds: [item.blobId] };
		}),
	);
	store.applyRefs(snapshot.domainId, refs);
}

function sealedBlobSize(size: number): number {
	return size + Math.max(1, Math.ceil(size / BLOB_CHUNK_BYTES)) * BLOB_FRAME_OVERHEAD_BYTES;
}

function blobChunkCount(size: number): number {
	return Math.max(1, Math.ceil(size / BLOB_CHUNK_BYTES));
}
