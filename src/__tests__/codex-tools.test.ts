import { describe, expect, it } from "vitest";
import { routerErrorText } from "../mcp/bridge/helpers.js";
import { CodexRequestErrorSchema, sanitizeCodexErrorText } from "../shared/codex-thinking.js";

/**
 * The seam between the gateway's typed refusals and what a caller actually reads.
 *
 * This layer had no test, and it shipped a regression: splitting request refusals into a 400 with a
 * structured `error` object left `routerPost` still reading that field as a string, so every refusal
 * reached the model as the literal text "[object Object]" - the one place the reason was needed.
 */

describe("what a caller reads from a gateway refusal", () => {
	it("reads the message out of a structured refusal", () => {
		// The exact shape the Codex route answers a request-level failure with.
		const body = CodexRequestErrorSchema.parse({
			error: {
				code: "invalid_input",
				retryable: false,
				message: sanitizeCodexErrorText("agent already has an unresolved prompt delivery"),
			},
		});

		expect(routerErrorText(body.error)).toBe("agent already has an unresolved prompt delivery");
		// The failure that shipped: stringifying the object instead of reading its message.
		expect(String(body.error)).toBe("[object Object]");
	});

	it("still reads a plain string error, which most routes answer with", () => {
		expect(routerErrorText("not found")).toBe("not found");
	});

	it("falls back rather than inventing text when the shape is neither", () => {
		expect(routerErrorText(undefined)).toBeUndefined();
		expect(routerErrorText({ code: "invalid_input" })).toBeUndefined();
		expect(routerErrorText(42)).toBeUndefined();
	});
});
