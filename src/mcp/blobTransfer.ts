import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/evie-protocol.js";
import { routerPost } from "./bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/** Where this process stages the blob plane's bytes. Content-addressed, so re-attaching a file the
 * gateway already holds, or receiving the same bytes twice, costs one round trip and no transfer. */
export function agentStagingRoot(): string {
	return `${process.env.TMPDIR ?? "/tmp"}/switchboard-blobs`;
}

// Resolved per call rather than cached: a BlobStore is just its root path, so there is nothing to
// keep, and holding one would pin the first TMPDIR this process ever saw.
function localBlobStore(): BlobStore {
	return new BlobStore(agentStagingRoot());
}

/** Ceiling for this process's staging copies. Smaller than the gateway's, since an agent stages
 * what it is sending or has just received rather than a whole Domain's traffic, but a MULTIPLE of
 * the largest single attachment and never equal to it: a store that can just barely hold one
 * max-size blob evicts it the moment a second transfer starts, so the two would fight instead of
 * queueing. That is the invariant, not the number. */
const MAX_STAGING_BYTES = MAX_BLOB_BYTES * 4;

/** Keep the staging store bounded. Called on every transfer rather than on a timer, because an MCP
 * process has no tick of its own, and the cost is one directory walk against work that just moved
 * megabytes. Content addressing makes eviction free: anything swept can be fetched again. */
export function sweepStaging(): void {
	try {
		localBlobStore().sweep({ maxBytes: MAX_STAGING_BYTES });
	} catch {
		// Reclaim is never worth failing a transfer over.
	}
}

/**
 * Put a local file's bytes on the gateway and return the reference that names them.
 *
 * A chunk at a time in both hops, so neither this process nor a request body ever holds the whole
 * file. `have` from each write is the resume cursor, so an interrupted upload continues instead of
 * restarting, and a re-sent chunk is a no-op because a blob is named by its own digest.
 */
export async function uploadBlob(filePath: string): Promise<string> {
	// Sweep BEFORE ingesting, never after. Sweeping after would let a file large enough to blow the
	// budget on its own be staged and then immediately evicted as the single over-budget entry,
	// leaving the very next line to fail on a blob that existed a millisecond earlier.
	sweepStaging();
	return pushStaged(localBlobStore().ingestFile(filePath));
}

/**
 * Put bytes already in memory on the gateway and return the reference that names them.
 *
 * For content this process GENERATES rather than reads: a `ref://` snapshot, a designer card. Those
 * are bounded and small by construction, so holding one is not the hazard [uploadBlob] exists to
 * avoid, and they still travel the one plane so the wire has a single shape for a file's bytes.
 */
export async function uploadBytes(bytes: Buffer): Promise<string> {
	const local = localBlobStore();
	const blobId = blobIdFor(bytes);
	if (!local.path(blobId)) {
		for (let offset = 0; ; offset += BLOB_CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, offset + BLOB_CHUNK_BYTES);
			const final = offset + chunk.length >= bytes.length;
			local.write(blobId, offset, chunk, final);
			if (final) break;
		}
	}
	return pushStaged(blobId);
}

/** Move a staged blob to the gateway, a chunk at a time, resuming from whatever it already holds.
 * `have` from each write IS the resume cursor, so an interrupted upload continues instead of
 * restarting, and a re-sent chunk is a no-op because a blob is named by its own digest. */
async function pushStaged(blobId: string): Promise<string> {
	const local = localBlobStore();
	const remote = (await routerPost("/blob/stat", { blobId })) as { have: number; complete: boolean };
	if (remote.complete) return blobId;

	let offset = remote.have ?? 0;
	const total = local.stat(blobId).have;
	for (;;) {
		const { bytes, eof } = local.read(blobId, offset, BLOB_CHUNK_BYTES);
		const final = eof || offset + bytes.length >= total;
		const ack = (await routerPost("/blob/put", {
			blobId,
			offset,
			chunk: bytes.toString("base64"),
			final,
		})) as { have: number; complete: boolean };
		if (final) {
			if (!ack.complete) throw new Error(`blob ${blobId} failed verification at the gateway`);
			return blobId;
		}
		// The gateway's cursor beats our own arithmetic: it is the side that knows what landed. But a
		// cursor that does not move means the chunk did not land, and re-sending it forever would
		// spin rather than fail, so a stalled transfer has to become an error the caller can see.
		if (ack.have <= offset) throw new Error(`blob ${blobId} stalled at offset ${offset}`);
		offset = ack.have;
	}
}

/**
 * Pull a blob's bytes down and return the local path holding them.
 *
 * Resumes from whatever this process already has, and returns immediately for a blob it holds in
 * full. The store seal-verifies the digest, so a truncated or tampered transfer never produces a
 * path at all.
 */
export async function downloadBlob(blobId: string, fromGateway?: string): Promise<string> {
	const local = localBlobStore();
	const held = local.path(blobId);
	if (held) return held;

	let offset = local.stat(blobId).have;
	for (;;) {
		// The far side decides when a transfer ends, so a peer that never sets `eof` would otherwise
		// stream onto this disk until it filled. Nothing legitimate crosses the plane's own ceiling.
		if (offset > MAX_BLOB_BYTES) throw new Error(`blob ${blobId} exceeded ${MAX_BLOB_BYTES} bytes`);
		// `fromGateway` says which Gateway holds the bytes. This process still only ever talks to its
		// own, which pulls the range in behind this call when it is not the holder.
		const res = (await routerPost("/blob/get", {
			blobId,
			offset,
			length: BLOB_CHUNK_BYTES,
			...(fromGateway ? { fromGateway } : {}),
		})) as { chunk?: string; eof: boolean };
		const bytes = Buffer.from(res.chunk ?? "", "base64");
		// A short read that is not the end would otherwise spin here forever asking for the same offset.
		if (bytes.length === 0 && !res.eof) throw new Error(`blob ${blobId} stalled at offset ${offset}`);
		const written = local.write(blobId, offset, bytes, res.eof);
		if (res.eof) {
			if (!written.complete) throw new Error(`blob ${blobId} failed verification after download`);
			const path = local.path(blobId);
			if (!path) throw new Error(`blob ${blobId} sealed but has no path`);
			return path;
		}
		offset = written.have;
	}
}
