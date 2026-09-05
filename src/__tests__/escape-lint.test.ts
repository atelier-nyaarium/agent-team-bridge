import { describe, expect, it } from "vitest";
import { BridgeSendSchema } from "../mcp/bridge/bridgeSend.js";
import { literalEscapeHazard, literalEscapeReject } from "../mcp/bridge/replyTool.js";

describe("literal escape lint", () => {
	it("detects structural escapes and ignores code and paths", () => {
		expect(literalEscapeHazard("intro\\n- item")).toContain("\\n- ");
		expect(literalEscapeHazard("line one\n- item")).toBeNull();
		expect(literalEscapeHazard("```\nvalue\\n- item\n```")).toBeNull();
		expect(literalEscapeHazard("C:\\new-folder\\notes.txt")).toBeNull();
	});

	it("produces guidance that is safe to submit again", () => {
		const snippet = literalEscapeHazard("body\\n- item");
		const guidance = literalEscapeReject("channel_reply", "full", snippet!);
		expect(literalEscapeHazard(guidance)).toBeNull();
		expect(guidance).toContain("full");
	});

	it("keeps displayLabel guidance aligned with its schema", () => {
		const description = BridgeSendSchema.shape.displayLabel.description ?? "";
		expect(description).toContain("REAL newlines");
		expect(BridgeSendSchema.shape.displayLabel.safeParse(undefined).success).toBe(true);
		expect(BridgeSendSchema.shape.displayLabel.safeParse(42).success).toBe(false);
	});
});
