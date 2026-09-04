import type { BlobStore } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/router-protocol.js";

////////////////////////////////
//  Interfaces & Types

export type BlobOp =
	| { kind: "blob_stat"; blobId: string; fromGateway?: string }
	| { kind: "blob_put"; blobId: string; offset: number; chunk: string; final: boolean }
	| { kind: "blob_get"; blobId: string; offset: number; length: number; fromGateway?: string };

/** What a mesh pull actually learned. "absent" is load-bearing: every named holder ANSWERED and
 * had nothing, which is the only evidence that retrying is pointless - "unreachable" must never
 * collapse into it, or a rebooting machine reads as a dead attachment. */
export type BlobFetchOutcome = "fetched" | "absent" | "unreachable";

/** Pulls a whole blob in from the Gateway that holds it, one bounded range at a time. Absent when
 * federation is not wired, which leaves a blob held elsewhere simply unavailable. */
export type BlobFetcher = (blobId: string, fromGateway: string) => Promise<BlobFetchOutcome>;

export type BlobOpResult = { have: number; complete: boolean } | { chunk?: string; eof: boolean; absent?: boolean };

/** A put refused on size: either the chunk is over the per-request cap, or the blob it would grow
 * is over the total. Named so the HTTP door can answer 413 rather than 500, since the difference
 * tells a caller whether the request was too big or the transfer was. */
export class BlobTooLarge extends Error {}

////////////////////////////////
//  Functions & Helpers

/**
 * One bounded range from this Gateway's blob store.
 *
 * Every byte reader on this Gateway goes through here, because there are THREE doors and not two:
 * the HTTP route and the console's sealed plane both arrive via [answerBlobOp], but a PEER Gateway's
 * `blob_fetch` is answered by `serveBlobRange`, which is neither. A missing blob is reported by the
 * store.
 */
export function readBlobRange(
	store: BlobStore,
	blobId: string,
	offset: number,
	length: number,
): { bytes: Buffer; eof: boolean } {
	const want = Math.min(length, BLOB_CHUNK_BYTES);
	return store.read(blobId, offset, want);
}

/**
 * Answer one blob op against the gateway's byte store.
 *
 * The SOLE implementation. The HTTP route and the console op plane are two doors onto the same
 * three operations, and a bound enforced at only one door is not a bound: the point of the whole
 * chunked plane is that no single request can name more bytes than fit comfortably in the heap, and
 * a second implementation is a second chance to forget that. Both directions are held here, a put
 * loudly (an oversized chunk is a caller that will keep sending them) and a get quietly (every
 * reader already advances on the returned cursor, so a short read costs one extra round trip).
 *
 * This is also where a transfer's TOTAL is bounded. A message states its file's `size`, but that is
 * the sender's own claim and nothing downstream re-measures it, so the only honest place to count
 * is the write path, against what has actually landed.
 *
 * A read for a blob this Gateway does not hold pulls it in from the one that does, when the caller
 * says where that is, and caches it. That indirection is the whole reason clients never need to
 * know which Gateway anything lives on: they ask their own, always, and it either has the bytes or
 * gets them. Content addressing makes the cache free of invalidation, since a name IS its contents.
 */
export async function answerBlobOp(
	store: BlobStore | undefined,
	op: BlobOp,
	fetch?: BlobFetcher,
): Promise<BlobOpResult> {
	if (!store) throw new Error("blob transfer unavailable on this Gateway");

	// A GET only. A stat is advertised as the cheap "how much do you have" that a resume asks before
	// committing to a transfer, so pulling a whole blob across the mesh to answer it inverts its
	// cost by four orders of magnitude. Nothing legitimate sets `fromGateway` on a stat, which is
	// exactly why a hand-crafted one must not become an amplifier.
	let fetched: BlobFetchOutcome | undefined;
	if (op.kind === "blob_get" && op.fromGateway && fetch && !store.path(op.blobId)) {
		fetched = await fetch(op.blobId, op.fromGateway);
	}

	switch (op.kind) {
		case "blob_stat":
			return store.stat(op.blobId);

		case "blob_put": {
			const chunk = Buffer.from(op.chunk, "base64");
			if (chunk.length > BLOB_CHUNK_BYTES) {
				throw new BlobTooLarge(`chunk of ${chunk.length} bytes exceeds ${BLOB_CHUNK_BYTES}`);
			}
			if (op.offset + chunk.length > MAX_BLOB_BYTES) {
				throw new BlobTooLarge(`blob would reach ${op.offset + chunk.length} bytes, over ${MAX_BLOB_BYTES}`);
			}
			return store.write(op.blobId, op.offset, chunk, op.final);
		}

		case "blob_get": {
			// A proven-absent pull answers BEFORE the ordinary read, which THROWS for a blob nobody
			// holds and would swallow the one piece of evidence this op exists to carry back: every
			// named holder answered and had nothing, and this Gateway still has nothing either. That
			// is what lets a client retire a fetch that can never succeed, instead of reading the
			// same failure a rebooting holder produces.
			// `have > 0` guards a concurrent upload: a .part does not satisfy path(), and calling bytes
			// that are actively landing "absent" would retire a live transfer.
			if (fetched === "absent" && !store.path(op.blobId) && store.stat(op.blobId).have === 0) {
				return { eof: false, absent: true };
			}
			const r = readBlobRange(store, op.blobId, op.offset, op.length);
			// An absent chunk, not an empty string: reading at or past the end has no bytes to report,
			// and "" would read as a zero-length chunk that landed.
			return { ...(r.bytes.length > 0 ? { chunk: r.bytes.toString("base64") } : {}), eof: r.eof };
		}
	}
}
