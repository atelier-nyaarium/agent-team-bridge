import { z } from "zod";

/** Mirrors board state without a module cycle. */
const BoardSessionSchema = z
	.object({ domainId: z.string(), gatewayId: z.string(), sessionId: z.string() })
	.meta({ id: "BoardSession" });

////////////////////////////////
//  Task Board Schemas
//
//  One entry of the owner's gateway-homed task board. FLAT: a parent pointer, never a children
//  array (the codegen cannot emit a recursive root); consoles and sessions rebuild the tree.

/** Body rides every plane snapshot and board_read reply, so its bound is what keeps a board under
 * the 8 MB sealed-frame cap alongside the mailbox. */
export const BOARD_BODY_MAX = 8192;

/** Mirrors board-rank.ts's RANK_MAX_LENGTH; the rank module rebalances instead of minting past it. */
export const BOARD_RANK_MAX = 64;

/** How many entries one upsert/remove may carry: a move ships a whole subtree as ONE linked pair,
 * so the bound is per-op, not per-entry. */
export const BOARD_BATCH_MAX = 200;

/** Attachments one entry may hold, matching `ChannelFilesSchema`. Bounds the fetching, not the bytes:
 * a few dozen entries at a handful of files each is noise against the projection budget. */
export const BOARD_ATTACHMENTS_MAX = 10;

/** Above this, a console does not fetch an attachment on its own; the owner taps to download.
 *
 * NOT a limit on what may be attached: the wire carries up to MAX_BLOB_BYTES in chunks and a board
 * attachment is no different. This only decides who pays for the transfer without being asked, which
 * matters because a second device opening an entry would otherwise pull hundreds of megabytes over
 * whatever connection it happens to be on. */
export const BOARD_AUTO_DOWNLOAD_MAX_BYTES = 25_000_000;

/** One attachment on a board entry. Field names mirror `ChannelFile` because every console path this
 * reuses is typed on it, and `blobId` is already the `sha256-<64 hex>` shape both stores demand. */
export const BoardAttachmentSchema = z
	.object({
		blobId: z.string().min(1).max(128),
		// The Gateway holding the bytes. A blob lives only where it landed, and an entry can be homed
		// on a different machine than the console's route, so a reference without a WHERE is dead.
		blobGateway: z.string().min(1).max(64),
		// Carried for CONTEXT, never for keying: it is how the owner says "look at mellisa-render.png"
		// and how an agent asks which of two screenshots is meant. The stored path is the content hash.
		filename: z.string().min(1).max(255),
		mime: z.string().max(255),
		size: z.number().int().nonnegative(),
	})
	.meta({ id: "BoardAttachment" });

export const BoardEntrySchema = z
	.object({
		// Writer-minted (console: random; MCP create: derived from the operation id), which is what
		// makes a replayed create the same entry and lets a cross-Gateway move keep its id.
		id: z.string().min(1).max(64),
		title: z.string().min(1).max(500),
		// Absent means no long-form text; an absolute set-body op with body absent CLEARS it.
		body: z.string().max(BOARD_BODY_MAX).optional(),
		state: z.enum(["open", "in_progress", "paused", "done", "cancelled"]),
		// Absent means top-level. An absolute set-parent op with parent absent means root - the op
		// always sets placement, it never leaves it unchanged.
		parent: z.string().min(1).max(64).optional(),
		rank: z.string().min(1).max(BOARD_RANK_MAX),
		// The session this entry is assigned to; absent means the backlog.
		sessionId: z.string().min(1).max(128).optional(),
		// The triple preserves cross-gateway identity.
		session: BoardSessionSchema.optional(),
		// Server-stamped when trashed; absent means live. The 30-day trash sweep runs off it.
		trashedAt: z.number().int().nonnegative().optional(),
		// Set only by the attachment operation; other writes preserve the stored list.
		attachments: z.array(BoardAttachmentSchema).max(BOARD_ATTACHMENTS_MAX).optional(),
	})
	.meta({ id: "BoardEntry" });
