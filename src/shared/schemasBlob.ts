import { z } from "zod";
import { BLOB_CHUNK_BYTES } from "./evie-protocol.js";

////////////////////////////////
//  Channel File Schema (inbound from evie-bot bridge)
//
//  ChannelFile lives in channel-file.ts (zod-only, NOT a synced leaf - evie
//  never reads it); the blob constants stay in the evie-protocol leaf. Both
//  re-export here so the console-protocol schemas and existing importers keep
//  one import surface.

/** `sha256-<64 hex>`. A blob is named by the digest of its own bytes and by nothing else. */
const BlobIdField = z.string().regex(/^sha256-[0-9a-f]{64}$/);

////////////////////////////////
//  Blob transfer ops
//
//  Bytes move here, in bounded chunks keyed by their own digest, rather than as a base64 field on a
//  message. `have` is the contiguous prefix the store holds, which is both the answer to "how much
//  got there" and the offset to resume from, so a retry needs no separate bookkeeping and a re-sent
//  chunk is a no-op.
//
//  Named rather than inlined into ConsoleOpSchema because these three ops have TWO doors: the sealed
//  console plane and the gateway's plain HTTP routes. `answerBlobOp` already made the handling
//  single; this makes the validation single too, so a bound cannot exist at one door and not the
//  other. A bare type cast at either door would skip that bound silently, with nothing to catch it.

/** Which Gateway holds the bytes, when it is not the one being asked. Absent means "you have them
 * or nobody does", which is every same-Gateway transfer. */
const FromGatewayField = z.string().min(1).max(64).optional();

export const BlobStatOpSchema = z.object({
	kind: z.literal("blob_stat"),
	blobId: BlobIdField,
	fromGateway: FromGatewayField,
});

export const BlobPutOpSchema = z.object({
	kind: z.literal("blob_put"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	// One chunk, base64'd. Bounded by BLOB_CHUNK_BYTES before encoding; the generous ceiling here is
	// the encoded form plus slack, not a second opinion on chunk size.
	chunk: z.string().max(BLOB_CHUNK_BYTES * 2),
	final: z.boolean(),
});

export const BlobGetOpSchema = z.object({
	kind: z.literal("blob_get"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	length: z.number().int().positive().max(BLOB_CHUNK_BYTES),
	fromGateway: FromGatewayField,
});

export { ChannelFileSchema, ChannelFilesSchema } from "./channel-file.js";
