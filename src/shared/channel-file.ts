import { z } from "zod";

////////////////////////////////
//  Channel file entries
//
//  The wire truth for a message's attachment list. Lives in its own zod-only module because BOTH
//  schemas.ts and federation-protocol.ts consume it and schemas.ts imports from federation-protocol,
//  so defining it in either would cycle. NOT a synced leaf: evie routes messages content-blind and
//  has no consumer of these shapes, so this file changes without the leaf ritual.

////////////////////////////////
//  Schemas

/**
 * Channel attachment metadata carried over the bridge (console-origin files).
 *
 * Metadata only. A message names its files and never carries them, so its size is bounded by the
 * count of attachments rather than by their contents, and the bytes move on the blob plane at
 * whatever pace and chunk size that plane chooses.
 */
export const ChannelFileSchema = z
	.object({
		filename: z.string().min(1).max(255),
		mime: z.string(),
		size: z.number().int().nonnegative(),
		descriptiveKey: z.string(),
		// The source file's own mtime in epoch MILLISECONDS, so a save on the far side can restore
		// the real age rather than stamping now. Optional: a sender that cannot determine one omits
		// it and the receiver hides the row. Populate from `mtime.getTime()`, never `mtimeMs`, which
		// is fractional and fails this integer check. Bounded to the ECMAScript Date range, since a
		// larger safe integer is representable here but not by the Date every consumer builds.
		modifiedAt: z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000).optional(),
		// The bytes, by the digest of the bytes: `sha256-<64 hex>`. Transferred out of band in
		// bounded chunks, so a message carrying a reference costs the same whether the file is
		// 4 KB or 4 GB. Optional because a file may legitimately name no bytes: a peer that could
		// not stage them still says the attachment existed rather than dropping it silently.
		blobId: z
			.string()
			.regex(/^sha256-[0-9a-f]{64}$/)
			.optional(),
		// WHICH Gateway holds those bytes. A blob lives on the one Gateway it was uploaded to, while
		// the message naming it routes by its own rules and regularly lands somewhere else, so a
		// reference that says only WHAT is unfetchable the moment the two differ. A receiver still
		// asks its OWN Gateway for the bytes; this tells that Gateway where to go and get them.
		// Absent means "wherever you are", which is correct for every same-Gateway transfer and is
		// what a peer predating this field implies.
		blobGateway: z.string().min(1).max(64).optional(),
	})
	.meta({ id: "ChannelFile" });

/**
 * Attachments on one message.
 *
 * Capped by COUNT, because bytes are no longer what a message costs. Each file is a reference the
 * receiver will chase, so an uncapped list is an uncapped amount of fetching however small the
 * message itself is: a thousand files declaring one byte each still points at a thousand blobs.
 * Ten matches the tightest renderer bound in the path (a Discord message) and is far above any real
 * reply.
 */
export const ChannelFilesSchema = z.array(ChannelFileSchema).max(10);

////////////////////////////////
//  Types

export type ChannelFile = z.infer<typeof ChannelFileSchema>;
