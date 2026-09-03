import { z } from "zod";
import { InboxRowSchema, OwnerOpSchema } from "./schemasInbox.js";

////////////////////////////////
//  Console socket frames

/** Plane-only socket mode. */
export const CONSOLE_PLANES_ONLY = "planes";

// Plane-only sockets register no inbox consumer.

export const ConsoleHelloFrameSchema = z
	.object({
		type: z.literal("hello"),
		ownerOp: OwnerOpSchema,
		mode: z.enum([CONSOLE_PLANES_ONLY]).optional(),
	})
	.meta({ id: "ConsoleHelloFrame" });

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
		payload: z.unknown().optional(),
	})
	.meta({ id: "ConsolePlaneFrame" });

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

export const CONSOLE_ROWS_PER_FRAME = 64;

export const CONSOLE_HELLO_DEADLINE_MS = 10_000;

export type ConsoleSocketInbound = z.infer<typeof ConsoleSocketInboundSchema>;
export type ConsoleSocketOutbound = z.infer<typeof ConsoleSocketOutboundSchema>;
export type ConsoleWelcomeFrame = z.infer<typeof ConsoleWelcomeFrameSchema>;
