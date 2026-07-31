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

/** A character span to highlight inside a snapshot, in original-file coordinates. */
export const RefSpanMetaSchema = z
	.object({
		startLine: z.number().int().positive(),
		startColumn: z.number().int().nonnegative(),
		endLine: z.number().int().positive(),
		endColumn: z.number().int().nonnegative(),
	})
	.meta({ id: "RefSpanMeta" });

/** One contiguous piece of the original file, as a line range. Carries NO text: the snapshot file
 * IS the segments' text joined with newlines, so `(startLine, lineCount)` partitions it exactly and
 * the bytes never ride the wire twice. */
export const RefSegmentMetaSchema = z
	.object({
		startLine: z.number().int().positive(),
		lineCount: z.number().int().positive(),
	})
	.meta({ id: "RefSegmentMeta" });

/** One canonical ref key this snapshot backs, and how it resolved. */
export const RefKeyMetaSchema = z
	.object({
		key: z.string().min(1).max(512),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		span: RefSpanMetaSchema.optional(),
		// Open string, not an enum: an older console must render a quality tier it has never heard
		// of as plain rather than reject the file.
		quality: z.string().min(1).max(32),
		reason: z.string().max(256).optional(),
		ambiguous: z.boolean().optional(),
		matchCount: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "RefKeyMeta" });

/** Hard bounds on one snapshot's metadata arrays. Load-bearing, not tidiness: per-file metadata
 * must stay bounded by the attachment COUNT, never by the sender's prose, and an oversized relay
 * frame closes the socket rather than failing one message. The producer refuses loudly at these
 * rather than truncating, so they are exported instead of restated. */
export const REF_META_MAX_SEGMENTS = 64;
export const REF_META_MAX_KEYS = 64;

/**
 * What a ref-snapshot file IS, declared by the sender: the source path it snapshots, which slice of
 * it (absent segments = the whole file), and the ref keys it backs. Authority over exactly ONE
 * file - the one carrying it - never over siblings, which is what makes it unforgeable-by-design:
 * the worst a false block can do is mislabel the bytes it rides with.
 */
export const RefFileMetaSchema = z
	.object({
		refPath: z.string().min(1).max(512),
		// min(1): an empty list and an absent one would both have to mean "the whole file", and two
		// spellings of one meaning is how a consumer branch goes untested. Absent is the spelling.
		segments: z.array(RefSegmentMetaSchema).min(1).max(REF_META_MAX_SEGMENTS).optional(),
		keys: z.array(RefKeyMetaSchema).max(REF_META_MAX_KEYS),
	})
	.meta({ id: "RefFileMeta" });

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
		// What this file IS, declared by the SENDER at compose time and never re-derived by a
		// receiver from bytes, filename, array position, or message direction. REQUIRED: absence is
		// not a state anyone interprets, it is a malformed message the edge rejects, so no receiver
		// can turn "the sender could not say" into a guess. A value a receiver does not RECOGNIZE is
		// different and stays permissive - it shows, demoted in sort and never a thumbnail, because
		// the sender said something deliberate and a wrong show heals at the receiver's next update
		// while a wrong hide is a file the user cannot reach. z.enum emits an open Kotlin String, so
		// a value newer than a given console still decodes there.
		role: z.enum(["attachment", "ref-snapshot", "design-card"]),
		// Ref metadata for a `role: "ref-snapshot"` file. See RefFileMetaSchema.
		ref: RefFileMetaSchema.optional(),
		// Designer card facts for a `role: "design-card"` file, lifted from the HTML at compose time
		// so the dock never opens the file to learn what a card is. Absent title falls back to the
		// filename stem on the console.
		cardTitle: z.string().min(1).max(200).optional(),
		cardGroup: z.string().max(64).optional(),
		cardWidth: z.number().int().positive().max(8192).optional(),
		cardHeight: z.number().int().positive().max(8192).optional(),
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
export type ChannelFileRole = NonNullable<ChannelFile["role"]>;
export type RefFileMeta = z.infer<typeof RefFileMetaSchema>;
export type RefKeyMeta = z.infer<typeof RefKeyMetaSchema>;
export type RefSegmentMeta = z.infer<typeof RefSegmentMetaSchema>;
