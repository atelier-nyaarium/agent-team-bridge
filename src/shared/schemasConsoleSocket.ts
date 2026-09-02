import { z } from "zod";
import { InboxRowSchema, OwnerOpSchema } from "./schemasInbox.js";

////////////////////////////////
//  Console socket frames
//
//  The socket carries PUSH only. Every mutation stays an HTTP OwnerOp, so reach failover stays per
//  call and there is one wire form for a write. What the socket buys is a row arriving without a
//  poll, and a cursor the Router already owns.

/** Opens the socket. Its `op.kind` is `hello`, and the one OwnerOp routine verifies it. */
/**
 * A console that takes planes but does not read the owner inbox.
 *
 * It registers NO consumer on purpose. A cursor sitting at zero would hold the inbox floor down
 * forever, since compaction takes the minimum cursor across consumers, so a console that never
 * drains would stop the inbox being reclaimed at all.
 */
export const CONSOLE_PLANES_ONLY = "planes";

export const ConsoleHelloFrameSchema = z
	.object({
		type: z.literal("hello"),
		ownerOp: OwnerOpSchema,
		/** Absent means this console reads the owner inbox. See [CONSOLE_PLANES_ONLY]. */
		mode: z.enum([CONSOLE_PLANES_ONLY]).optional(),
	})
	.meta({ id: "ConsoleHelloFrame" });

/** Advances the consumer cursor. The Router refuses one that is below the compaction floor. */
export const ConsoleAckFrameSchema = z
	.object({
		type: z.literal("ack"),
		incarnation: z.number().int().nonnegative(),
		cursor: z.number().int().nonnegative(),
		cursorEpoch: z.number().int().nonnegative(),
	})
	.meta({ id: "ConsoleAckFrame" });

export const ConsolePingFrameSchema = z
	.object({ type: z.literal("ping"), incarnation: z.number().int().nonnegative() })
	.meta({ id: "ConsolePingFrame" });

export const ConsoleSocketInboundSchema = z
	.discriminatedUnion("type", [ConsoleHelloFrameSchema, ConsoleAckFrameSchema, ConsolePingFrameSchema])
	.meta({ id: "ConsoleSocketInbound" });

/** Answers `hello`. `versions` is what the Router holds per plane, so a phone that already has a
 * version skips the payload. `floor` is the compaction floor its cursor may not fall below. */
export const ConsoleWelcomeFrameSchema = z
	.object({
		type: z.literal("welcome"),
		incarnation: z.number().int().positive(),
		cursor: z.number().int().nonnegative(),
		cursorEpoch: z.number().int().nonnegative(),
		floor: z.number().int().nonnegative(),
		versions: z.record(z.string(), z.number().int().nonnegative()),
	})
	.meta({ id: "ConsoleWelcomeFrame" });

export const ConsoleInboxRowsFrameSchema = z
	.object({
		type: z.literal("inbox_rows"),
		incarnation: z.number().int().positive(),
		rows: z.array(InboxRowSchema),
		cursor: z.number().int().nonnegative(),
	})
	.meta({ id: "ConsoleInboxRowsFrame" });

export const ConsolePlaneFrameSchema = z
	.object({
		type: z.literal("plane"),
		incarnation: z.number().int().positive(),
		name: z.string().min(1).max(64),
		version: z.number().int().nonnegative(),
		/** Absent for a plane that pokes rather than pushes, so the reader re-reads instead. */
		payload: z.unknown().optional(),
	})
	.meta({ id: "ConsolePlaneFrame" });

/** The socket closes after this. A cursor below the floor names the floor and the dropped count, so
 * the phone can show the gap rather than silently skipping rows. */
export const ConsoleRefusedFrameSchema = z
	.object({
		type: z.literal("refused"),
		reason: z.string().min(1).max(64),
		floor: z.number().int().nonnegative().optional(),
		dropped: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "ConsoleRefusedFrame" });

export const ConsolePongFrameSchema = z
	.object({ type: z.literal("pong"), incarnation: z.number().int().positive() })
	.meta({ id: "ConsolePongFrame" });

export const ConsoleSocketOutboundSchema = z
	.discriminatedUnion("type", [
		ConsoleWelcomeFrameSchema,
		ConsoleInboxRowsFrameSchema,
		ConsolePlaneFrameSchema,
		ConsoleRefusedFrameSchema,
		ConsolePongFrameSchema,
	])
	.meta({ id: "ConsoleSocketOutbound" });

/** Rows per push. A phone behind its cursor drains in batches rather than one frame. */
export const CONSOLE_ROWS_PER_FRAME = 64;

/** A socket that has not said hello by this deadline is closed. */
export const CONSOLE_HELLO_DEADLINE_MS = 10_000;

export type ConsoleSocketInbound = z.infer<typeof ConsoleSocketInboundSchema>;
export type ConsoleSocketOutbound = z.infer<typeof ConsoleSocketOutboundSchema>;
export type ConsoleWelcomeFrame = z.infer<typeof ConsoleWelcomeFrameSchema>;
