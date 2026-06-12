import { describe, expect, it } from "vitest";
import { EvieInboundFrameSchema, ToolCallFrameSchema } from "../shared/evie-protocol.js";

////////////////////////////////
//  Evie bridge frame schemas
//
//  The boundary union evieClient parses inbound frames with. The phone_relay
//  member is deliberately loose (the relay pump owns full validation); the
//  rest are exact decode shapes.

describe("evie inbound frame union", () => {
	it("parses a tool_registry frame", () => {
		const frame = EvieInboundFrameSchema.parse({
			type: "tool_registry",
			tools: [{ name: "evie_search", description: "Search the web", parameters: { type: "object" } }],
		});
		expect(frame.type).toBe("tool_registry");
		if (frame.type === "tool_registry") expect(frame.tools).toHaveLength(1);
	});

	it("parses tool_result and tool_error frames", () => {
		expect(
			EvieInboundFrameSchema.safeParse({ type: "tool_result", callId: "c1", result: { ok: true } }).success,
		).toBe(true);
		expect(EvieInboundFrameSchema.safeParse({ type: "tool_error", callId: "c1", error: "boom" }).success).toBe(
			true,
		);
	});

	it("accepts tool_error with callId null (evie sends it for unattributable failures)", () => {
		const result = EvieInboundFrameSchema.safeParse({ type: "tool_error", callId: null, error: "invalid JSON" });
		expect(result.success).toBe(true);
	});

	it("parses a dm_forward frame with files", () => {
		const result = EvieInboundFrameSchema.safeParse({
			type: "dm_forward",
			content: "hi",
			userId: "u1",
			channelId: "ch1",
			messageId: "m1",
			files: [{ filename: "a.png", mime: "image/png", size: 4, descriptiveKey: "a" }],
		});
		expect(result.success).toBe(true);
	});

	it("keeps phone_relay loose - the relay pump owns full validation", () => {
		const result = EvieInboundFrameSchema.safeParse({
			type: "phone_relay",
			v: 1,
			device: "pixel",
			conversationId: "conv-1",
			opId: "op-1",
			op: { kind: "register" },
			some_future_field: true,
		});
		expect(result.success).toBe(true);
	});

	it("rejects unknown frame types (consumer logs and drops)", () => {
		expect(EvieInboundFrameSchema.safeParse({ type: "mystery_frame", payload: 1 }).success).toBe(false);
	});

	it("rejects a malformed dm_forward envelope", () => {
		expect(EvieInboundFrameSchema.safeParse({ type: "dm_forward", content: "hi" }).success).toBe(false);
	});
});

describe("tool_call frame", () => {
	it("round-trips the outbound shape", () => {
		const frame = ToolCallFrameSchema.parse({
			type: "tool_call",
			callId: "c2",
			action: "phone_relay_reply",
			params: { opId: "op-1", ok: true },
		});
		expect(frame.action).toBe("phone_relay_reply");
	});
});
