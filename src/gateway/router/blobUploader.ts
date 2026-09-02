////////////////////////////////
//  Uploading blobs to the Router
//
//  The origin keeps its copy either way: the cache is a second place to read from, not a handover.
//
//  Unwired on purpose. This moves bytes as they are, and the Router's stores are specified sealed.
//  Sealing a blob is unsolved: the stores verify against the plaintext digest the blob id asserts,
//  and a range read has to land on a decryptable boundary. Wiring it hands the Router plaintext.

import type { BlobStore } from "../../shared/blob-store.js";
import { BLOB_CHUNK_BYTES } from "../../shared/router-protocol.js";

export type BlobRef = { kind: "entry" | "row" | "scheduled"; id: string };

export interface BlobUploaderDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	blobs: Pick<BlobStore, "stat" | "read">;
	incarnation: () => number | null;
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
		const begun = await deps.call("blob_begin", { blobId, size, store, ...(ref ? { ref } : {}) });
		if (begun.error) return { kind: "failed", error: begun.error };
		const answer = (begun.result ?? {}) as BeginAnswer;
		// Existing blobs need no bytes.
		if ("kind" in answer && answer.kind === "exists") return { kind: "already_held" };
		if (!("kind" in answer) || answer.kind !== "lease")
			return { kind: "failed", error: "error" in answer ? answer.error : "begin refused" };
		const lease = answer.lease;
		for (let offset = 0; offset < size; offset += BLOB_CHUNK_BYTES) {
			const length = Math.min(BLOB_CHUNK_BYTES, size - offset);
			const read = deps.blobs.read(blobId, offset, length);
			const final = offset + length >= size;
			const sent = await deps.call("blob_chunk", {
				blobId,
				store,
				lease,
				offset,
				bytes: read.bytes.toString("base64"),
				final,
			});
			if (sent.error) return { kind: "failed", error: sent.error };
			const chunkAnswer = (sent.result ?? {}) as { kind?: string; error?: string };
			// A kind on the answer names the refusal; success carries none.
			if (chunkAnswer.error) return { kind: "failed", error: chunkAnswer.error };
			if (chunkAnswer.kind) return { kind: "failed", error: chunkAnswer.kind };
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
