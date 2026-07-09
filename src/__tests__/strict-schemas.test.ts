import { describe, expect, it } from "vitest";
import { ChannelReplySchema, ChannelReplyStructuredSchema } from "../shared/schemas.js";

// The silent-strip class: Zod strips unknown keys by default, so a mistyped
// agent-facing field name forwards nothing and the reply lands empty. These
// schemas are `.strict()`, so a typo is rejected at the boundary (surfaced
// to the agent as an InvalidParams tool error) instead of vanishing.

const VALID_REPLY = { session_id: "s1", title: "Title", summary: "Summary sentence.", full: "The reply body." };

describe("ChannelReplySchema", () => {
	it("accepts a valid reply", () => {
		expect(ChannelReplySchema.safeParse(VALID_REPLY).success).toBe(true);
	});

	it("accepts a valid reply with attachments", () => {
		const r = ChannelReplySchema.safeParse({ ...VALID_REPLY, attachments: ["/tmp/screenshot.png"] });
		expect(r.success).toBe(true);
	});

	it("rejects a typo'd field even when every real field is otherwise valid", () => {
		const r = ChannelReplySchema.safeParse({ ...VALID_REPLY, fulll: "typo'd" });
		expect(r.success).toBe(false);
	});

	it("rejects a stray status field (channel replies carry no status)", () => {
		const r = ChannelReplySchema.safeParse({ ...VALID_REPLY, status: "running" });
		expect(r.success).toBe(false);
	});

	it("rejects a missing title", () => {
		const { title: _title, ...rest } = VALID_REPLY;
		expect(ChannelReplySchema.safeParse(rest).success).toBe(false);
	});

	it("rejects a missing summary", () => {
		const { summary: _summary, ...rest } = VALID_REPLY;
		expect(ChannelReplySchema.safeParse(rest).success).toBe(false);
	});

	it("rejects a missing full", () => {
		const { full: _full, ...rest } = VALID_REPLY;
		expect(ChannelReplySchema.safeParse(rest).success).toBe(false);
	});

	it("rejects an empty full (NoticeFull requires min length 1)", () => {
		const r = ChannelReplySchema.safeParse({ ...VALID_REPLY, full: "" });
		expect(r.success).toBe(false);
	});

	it("rejects attachments with no full (attachments-only is no longer allowed)", () => {
		const r = ChannelReplySchema.safeParse({ session_id: "s1", attachments: ["/tmp/screenshot.png"] });
		expect(r.success).toBe(false);
	});
});

describe("ChannelReplyStructuredSchema", () => {
	it("accepts an object responseData", () => {
		const r = ChannelReplyStructuredSchema.safeParse({ session_id: "s1", responseData: { isMainOrLead: true } });
		expect(r.success).toBe(true);
	});

	it("rejects a JSON string responseData (must be a native object)", () => {
		const r = ChannelReplyStructuredSchema.safeParse({ session_id: "s1", responseData: '{"isMainOrLead":true}' });
		expect(r.success).toBe(false);
	});

	it("rejects a typo'd field even when responseData is otherwise valid", () => {
		const r = ChannelReplyStructuredSchema.safeParse({ session_id: "s1", responseData: {}, responseDataa: {} });
		expect(r.success).toBe(false);
	});
});
