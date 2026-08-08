// Codex delegation: the `codex app-server` JSONL protocol itself (its thread/turn/item shapes,
// its request/response envelope), as distinct from our own gateway-daemon relay in
// codexThinkingRelay.ts. `looseObject` throughout because the App Server is a third party: we
// project only the fields we read and tolerate whatever else it sends.

import { z } from "zod";
import { CodexTurnStateSchema } from "./codexThinkingAgentState.js";
import { OpaqueIdSchema } from "./codexThinkingIdentity.js";

export const CodexAppServerResponseSchema = z
	.looseObject({
		id: z.union([z.string(), z.number()]),
		result: z.unknown().optional(),
		error: z
			.looseObject({
				code: z.number(),
				message: z.string(),
			})
			.optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.result === undefined) === (value.error === undefined)) {
			ctx.addIssue({ code: "custom", message: "response requires exactly one of result or error" });
		}
	});

const CodexAppServerThreadIdentitySchema = z.looseObject({ id: OpaqueIdSchema });
export const CodexAppServerAgentMessageItemSchema = z.looseObject({
	type: z.literal("agentMessage"),
	id: OpaqueIdSchema,
	text: z.string(),
	phase: z.string().nullish(),
});
const CodexAppServerOtherItemSchema = z
	.looseObject({
		id: OpaqueIdSchema,
		type: z.string().min(1),
	})
	.refine((item) => item.type !== "agentMessage", "agent messages require text");
export const CodexAppServerThreadItemProjectionSchema = z.union([
	CodexAppServerAgentMessageItemSchema,
	CodexAppServerOtherItemSchema,
]);
const CodexAppServerTurnProjectionSchema = z.looseObject({
	id: OpaqueIdSchema,
	status: CodexTurnStateSchema,
	items: z.array(CodexAppServerThreadItemProjectionSchema),
});

export const CodexAppServerThreadStartResultSchema = z.looseObject({
	thread: CodexAppServerThreadIdentitySchema,
});
export const CodexAppServerThreadResumeResultSchema = z.looseObject({
	thread: CodexAppServerThreadIdentitySchema,
});
export const CodexAppServerThreadReadResultSchema = z.looseObject({
	thread: z.looseObject({
		id: OpaqueIdSchema,
		turns: z.array(CodexAppServerTurnProjectionSchema),
	}),
});
export const CodexAppServerTurnStartResultSchema = z.looseObject({
	turn: CodexAppServerTurnProjectionSchema.extend({ status: z.literal("inProgress") }),
});
export const CodexAppServerTurnSteerResultSchema = z.looseObject({ turnId: OpaqueIdSchema });
export const CodexAppServerEmptyResultSchema = z.looseObject({});

export const CodexAppServerAgentMessageCompletedSchema = z.looseObject({
	method: z.literal("item/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turnId: OpaqueIdSchema,
		item: CodexAppServerAgentMessageItemSchema,
	}),
});

export const CodexAppServerTurnCompletedSchema = z.looseObject({
	method: z.literal("turn/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turn: z.looseObject({
			id: OpaqueIdSchema,
			status: z.enum(["completed", "failed", "interrupted"]),
			error: z
				.looseObject({
					message: z.string(),
				})
				.nullish(),
		}),
	}),
});

/**
 * What one App Server item is, by its `phase`.
 *
 * The SOLE owner of that vocabulary. Two readers need it - the live tracker as items stream in, and
 * the rebuild that reconstructs a turn from `thread/read` after a restart - and both MUST agree on
 * it: a reader that does not recognize `commentary` treats a completed turn with no final answer as
 * if its last narration line were the answer.
 *
 * `candidate` is deliberately the default for an unrecognized phase: dropping agent text loses it
 * entirely, while treating narration as an answer is only wrong when a real answer exists.
 */
export function classifyCodexItemPhase(phase: unknown): "answer" | "commentary" | "candidate" {
	if (phase === "final_answer") return "answer";
	if (phase === "commentary") return "commentary";
	return "candidate";
}

export const CodexAppServerRequestSchema = z.looseObject({
	id: z.union([z.string(), z.number()]),
	method: z.string().min(1),
	params: z.unknown().optional(),
});
