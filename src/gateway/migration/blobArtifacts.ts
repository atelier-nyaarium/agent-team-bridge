import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { BLOB_CHUNK_BYTES } from "../../shared/router-protocol.js";
import type { MigrationBlob, MigrationExport } from "../../shared/schemasMigration.js";
import { sealBlobChunk, sealedBlobChunkCount } from "../../shared/sealed-blob.js";

export type BlobSource = (blobId: string) => Buffer | null;

export function writeBlobArtifacts(
	snapshot: MigrationExport,
	outDir: string,
	read: BlobSource,
	key: Buffer,
	ownerSignPub: string,
): { manifest: MigrationBlob[]; missing: string[] } {
	const root = path.join(outDir, "blobs");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
	const manifest: MigrationBlob[] = [];
	const missing: string[] = [];
	for (const blobId of referencedBlobIds(snapshot)) {
		const plaintext = read(blobId);
		if (!plaintext) {
			missing.push(blobId);
			continue;
		}
		const frames: Buffer[] = [];
		for (let index = 0; index < sealedBlobChunkCount(plaintext.length); index++) {
			const start = index * BLOB_CHUNK_BYTES;
			const chunk = plaintext.subarray(start, start + BLOB_CHUNK_BYTES);
			frames.push(
				sealBlobChunk(
					chunk,
					key,
					{ domainId: snapshot.domainId, ownerSignPub, epoch: 1, blobId },
					index,
					index + 1 === sealedBlobChunkCount(plaintext.length),
				),
			);
		}
		const bytes = Buffer.concat(frames);
		const ciphertextDigest = createHash("sha256").update(bytes).digest("hex");
		writeFileAtomic(path.join(root, blobId), bytes, { mode: 0o600 });
		manifest.push({
			blobId,
			size: plaintext.length,
			ciphertextDigest,
			referencedBy: referencesFor(snapshot, blobId),
		});
	}
	writeFileAtomic(path.join(outDir, "blobs.json"), JSON.stringify(manifest, null, "\t"), { mode: 0o600 });
	return { manifest, missing };
}

function referencedBlobIds(snapshot: MigrationExport): Set<string> {
	const ids = new Set<string>();
	for (const owner of snapshot.owners) {
		for (const item of owner.board)
			for (const attachment of item.entry.attachments ?? []) ids.add(attachment.blobId);
	}
	return ids;
}

function referencesFor(snapshot: MigrationExport, blobId: string): string[] {
	const refs: string[] = [];
	for (const owner of snapshot.owners) {
		for (const item of owner.board)
			if (item.entry.attachments?.some((attachment) => attachment.blobId === blobId))
				refs.push(`entry:${encodeURIComponent(item.entry.id)}`);
	}
	return refs;
}
