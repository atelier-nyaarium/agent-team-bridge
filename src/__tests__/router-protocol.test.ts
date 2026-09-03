import { describe, expect, it } from "vitest";
import { RouterInboundFrameSchema, ToolCallFrameSchema } from "../shared/router-protocol.js";

////////////////////////////////
//  Router bridge frame schemas
//

describe("Router inbound frame union", () => {
	it("rejects a retired tool_registry frame (the tool proxy is gone)", () => {
		expect(RouterInboundFrameSchema.safeParse({ type: "tool_registry", tools: [] }).success).toBe(false);
	});

	it("parses tool_result and tool_error frames", () => {
		expect(
			RouterInboundFrameSchema.safeParse({ type: "tool_result", callId: "c1", result: { ok: true } }).success,
		).toBe(true);
		expect(RouterInboundFrameSchema.safeParse({ type: "tool_error", callId: "c1", error: "boom" }).success).toBe(
			true,
		);
	});

	it("accepts tool_error with callId null (the Router sends it for unattributable failures)", () => {
		const result = RouterInboundFrameSchema.safeParse({ type: "tool_error", callId: null, error: "invalid JSON" });
		expect(result.success).toBe(true);
	});

	it("rejects unknown frame types (consumer logs and drops)", () => {
		expect(RouterInboundFrameSchema.safeParse({ type: "mystery_frame", payload: 1 }).success).toBe(false);
	});

	it("rejects dm_forward frames - the Discord human path is retired", () => {
		// dm_forward no longer has a union member, so even a fully-formed one falls
		// through to the unknown-type drop. Guards against silently re-adding it.
		const result = RouterInboundFrameSchema.safeParse({
			type: "dm_forward",
			content: "hi",
			userId: "u1",
			channelId: "ch1",
			messageId: "m1",
		});
		expect(result.success).toBe(false);
	});
});

describe("tool_call frame", () => {
	it("round-trips the outbound shape", () => {
		const frame = ToolCallFrameSchema.parse({
			type: "tool_call",
			callId: "c2",
			action: "value_result",
			params: { opId: "op-1", ok: true },
		});
		expect(frame.action).toBe("value_result");
	});
});
