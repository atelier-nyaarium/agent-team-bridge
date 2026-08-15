import { BlobStore, blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/evie-protocol.js";
import { routerPost } from "./bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/** Content-addressed, so re-sending bytes the gateway holds costs a round trip and no transfer. */
export function agentStagingRoot(): string {
	return `${process.env.TMPDIR ?? "/tmp"}/switchboard-blobs`;
}

// Per call, not cached: holding one would pin the first TMPDIR this process saw.
function localBlobStore(): BlobStore {
	return new BlobStore(agentStagingRoot());
}

/** A MULTIPLE of the largest attachment, never equal to it: a store holding exactly one max blob
 * evicts it the moment a second transfer starts, so the two fight instead of queueing. */
const MAX_STAGING_BYTES = MAX_BLOB_BYTES * 4;

/** On every transfer, since an MCP process has no tick. Eviction is free: anything swept refetches. */
export function sweepStaging(): void {
	try {
		localBlobStore().sweep({ maxBytes: MAX_STAGING_BYTES });
	} catch {
		// Reclaim is never worth failing a transfer over.
	}
}

/** A chunk at a time in both hops, so neither this process nor a request body holds the whole file. */
export async function uploadBlob(filePath: string): Promise<string> {
	// BEFORE ingesting: sweeping after would evict an over-budget file the next line then fails on.
	sweepStaging();
	return pushStaged(localBlobStore().ingestFile(filePath));
}

/** For content this process GENERATES, which is bounded and small, so holding it is not the hazard
 * uploadBlob avoids. Still one plane, so the wire has one shape for a file's bytes. */
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

/** `have` IS the resume cursor. A re-sent chunk is a no-op: the blob is named by its own digest. */
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
		// The gateway's cursor wins, but one that never moves means the chunk never landed.
		if (ack.have <= offset) throw new Error(`blob ${blobId} stalled at offset ${offset}`);
		offset = ack.have;
	}
}

/** The store seal-verifies the digest, so a truncated or tampered transfer never produces a path. */
export async function downloadBlob(blobId: string, fromGateway?: string): Promise<string> {
	const local = localBlobStore();
	const held = local.path(blobId);
	if (held) return held;

	let offset = local.stat(blobId).have;
	for (;;) {
		// A peer that never sets `eof` would otherwise stream onto this disk until it filled.
		if (offset > MAX_BLOB_BYTES) throw new Error(`blob ${blobId} exceeded ${MAX_BLOB_BYTES} bytes`);
		// This process only ever talks to its own gateway, which pulls a foreign holder's bytes in.
		const res = (await routerPost("/blob/get", {
			blobId,
			offset,
			length: BLOB_CHUNK_BYTES,
			...(fromGateway ? { fromGateway } : {}),
		})) as { chunk?: string; eof: boolean };
		const bytes = Buffer.from(res.chunk ?? "", "base64");
		// A short non-final read would otherwise spin forever asking for the same offset.
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
