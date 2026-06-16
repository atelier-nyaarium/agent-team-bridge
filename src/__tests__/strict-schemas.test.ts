import { describe, expect, it } from "vitest";
import { ChannelReplySchema, CliReplySchema } from "../shared/schemas.js";

// The silent-strip class: Zod strips unknown keys by default, so a mistyped
// agent-facing field name forwards nothing and the reply lands empty. These
// schemas are now `.strict()`, so a typo is rejected at the boundary (surfaced
// to the agent as an InvalidParams tool error) instead of vanishing.

describe("strict agent-facing reply schemas", () => {
	it("CliReplySchema rejects a typo'd body field (the dead-guard bug)", () => {
		const r = CliReplySchema.safeParse({
			session_id: "s1",
			status: "completed",
			respondAsMarkdownStringg: "the answer", // one stray g
		});
		expect(r.success).toBe(false);
	});

	it("CliReplySchema accepts a valid completed reply", () => {
		const r = CliReplySchema.safeParse({
			session_id: "s1",
			status: "completed",
			respondAsMarkdownString: "the answer",
		});
		expect(r.success).toBe(true);
	});

	it("CliReplySchema accepts a clarification reply with question and no body", () => {
		const r = CliReplySchema.safeParse({
			session_id: "s1",
			status: "clarification",
			question: "which environment?",
		});
		expect(r.success).toBe(true);
	});

	it("ChannelReplySchema rejects a typo'd body field", () => {
		const r = ChannelReplySchema.safeParse({
			session_id: "s1",
			respondAsMarkdownStringg: "hi", // typo
		});
		expect(r.success).toBe(false);
	});

	it("ChannelReplySchema rejects a stray status field (not a channel param)", () => {
		const r = ChannelReplySchema.safeParse({
			session_id: "s1",
			respondAsMarkdownString: "hi",
			status: "running", // channel replies carry no status
		});
		expect(r.success).toBe(false);
	});

	it("ChannelReplySchema accepts a valid markdown reply", () => {
		const r = ChannelReplySchema.safeParse({
			session_id: "s1",
			respondAsMarkdownString: "hi",
		});
		expect(r.success).toBe(true);
	});

	it("the mutual-exclusion refine still fires under strict", () => {
		const r = ChannelReplySchema.safeParse({
			session_id: "s1",
			respondAsMarkdownString: "a",
			respondAsStructuredData: "{}",
		});
		expect(r.success).toBe(false);
	});
});
