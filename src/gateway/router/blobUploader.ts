import crypto from "node:crypto";
import type { BlobStore } from "../../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, BLOB_CIPHERTEXT_CHUNK_BYTES, BLOB_NONCE_BYTES } from "../../shared/router-protocol.js";
import { sealBlobChunk, sealedBlobChunkCount, sealedBlobSize } from "../../shared/sealed-blob.js";

export type BlobRef = { kind: "entry" | "row" | "scheduled"; id: string };

export interface BlobUploaderDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	blobs: Pick<BlobStore, "stat" | "read">;
	incarnation: () => number | null;
	domainId: string;
	ownerSignPub: () => string | null;
	keys: {
		epochs(): number[];
		keyFor(epoch: number): Buffer | null;
	};
}

type BeginAnswer =
	| { kind: "lease"; lease: { id: string; generation: number } }
	| { kind: "exists" }
	| { kind: "quota" }
	| { ok: false; error: string };

export type UploadOutcome =
	| { kind: "uploaded" }
	| { kind: "already_held" }
	| { kind: "absent" }
	| { kind: "failed"; error: string };

export function createBlobUploader(deps: BlobUploaderDeps) {
	async function upload(blobId: string, store: "cache" | "held", ref?: BlobRef): Promise<UploadOutcome> {
		if (deps.incarnation() === null) return { kind: "failed", error: "Gateway is not registered" };
		const stat = deps.blobs.stat(blobId);
		// Copy complete blobs only.
		if (!stat.complete || stat.size === undefined) return { kind: "absent" };
		const size = stat.size;
		const ownerSignPub = deps.ownerSignPub();
		const epoch = deps.keys.epochs().at(-1);
		const key = epoch === undefined ? null : deps.keys.keyFor(epoch);
		if (!ownerSignPub || epoch === undefined || !key)
			return { kind: "failed", error: "Content key is unavailable" };
		const context = { domainId: deps.domainId, ownerSignPub, epoch, blobId };
		const nonces: Buffer[] = [];
		const hash = crypto.createHash("sha256");
		for (let index = 0; index < sealedBlobChunkCount(size); index++) {
			const offset = index * BLOB_CHUNK_BYTES;
			const length = Math.min(BLOB_CHUNK_BYTES, size - offset);
			const nonce = crypto.randomBytes(BLOB_NONCE_BYTES);
			nonces.push(nonce);
			const read = length === 0 ? { bytes: Buffer.alloc(0) } : deps.blobs.read(blobId, offset, length);
			hash.update(
				sealBlobChunk(read.bytes, key, context, index, index + 1 === sealedBlobChunkCount(size), nonce),
			);
		}
		const ciphertextSize = sealedBlobSize(size);
		const ciphertextDigest = `sha256-${hash.digest("hex")}`;
		const begun = await deps.call("blob_begin", {
			blobId,
			size,
			ciphertextSize,
			ciphertextDigest,
			epoch,
			store,
			...(ref ? { ref } : {}),
		});
		if (begun.error) return { kind: "failed", error: begun.error };
		const answer = (begun.result ?? {}) as BeginAnswer;
		// Existing blobs need no bytes.
		if ("kind" in answer && answer.kind === "exists") return { kind: "already_held" };
		if (!("kind" in answer) || answer.kind !== "lease")
			return { kind: "failed", error: "error" in answer ? answer.error : "begin refused" };
		const lease = answer.lease;
		for (let index = 0; index < sealedBlobChunkCount(size); index++) {
			const offset = index * BLOB_CHUNK_BYTES;
			const length = Math.min(BLOB_CHUNK_BYTES, size - offset);
			const read = length === 0 ? { bytes: Buffer.alloc(0) } : deps.blobs.read(blobId, offset, length);
			const final = index + 1 === sealedBlobChunkCount(size);
			const frame = sealBlobChunk(read.bytes, key, context, index, final, nonces[index]);
			const sent = await deps.call("blob_chunk", {
				blobId,
				store,
				lease,
				offset: index * BLOB_CIPHERTEXT_CHUNK_BYTES,
				bytes: frame.toString("base64"),
				final,
			});
			if (sent.error) return { kind: "failed", error: sent.error };
			const chunkAnswer = (sent.result ?? {}) as { kind?: string; error?: string; complete?: boolean };
			// A kind on the answer names the refusal; success carries none.
			if (chunkAnswer.error) return { kind: "failed", error: chunkAnswer.error };
			if (chunkAnswer.kind) return { kind: "failed", error: chunkAnswer.kind };
			// Final verification may delete the partial. complete:false must not report an uploaded blob.
			if (final && chunkAnswer.complete !== true) return { kind: "failed", error: "ciphertext_unverified" };
		}
		return { kind: "uploaded" };
	}

	/** Skips absent blobs so receivers can use blob_fetch. */
	async function uploadAll(blobIds: readonly string[], store: "cache" | "held", ref?: BlobRef): Promise<string[]> {
		const held: string[] = [];
		for (const blobId of blobIds) {
			const outcome = await upload(blobId, store, ref);
			if (outcome.kind === "uploaded" || outcome.kind === "already_held") held.push(blobId);
			else if (outcome.kind === "failed") console.warn(`[blob-upload] ${blobId}: ${outcome.error}`);
		}
		return held;
	}

	return { upload, uploadAll };
}
