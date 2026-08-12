import { describe, expect, it } from "vitest";
import { copilotRequestBody } from "../mcp/copilot/copilotTools.js";
import {
	COPILOT_ERROR_MAX_BYTES,
	COPILOT_PROMPT_MAX_BYTES,
	CopilotAgentResultSchema,
	CopilotErrorTextSchema,
	CopilotGatewayRequestSchema,
	CopilotStartAgentInputSchema,
	sanitizeCopilotErrorText,
} from "../shared/copilot-thinking.js";

const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

describe("Copilot tool contracts", () => {
	it("builds a gateway-valid request for every tool", () => {
		const bodies = [
			copilotRequestBody("start", { prompt: "Review" }),
			copilotRequestBody("message", { agentId: AGENT_ID, prompt: "Continue" }),
			copilotRequestBody("await", { agentId: AGENT_ID }),
			copilotRequestBody("stop", { agentId: AGENT_ID }),
			copilotRequestBody("list"),
		];

		for (const body of bodies) expect(CopilotGatewayRequestSchema.safeParse(body).success).toBe(true);
	});

	it("mints operation ids only for mutations", () => {
		const first = copilotRequestBody("start", { prompt: "Review" });
		const second = copilotRequestBody("start", { prompt: "Review" });

		expect(first.operationId).not.toBe(second.operationId);
		expect(copilotRequestBody("await", { agentId: AGENT_ID })).not.toHaveProperty("operationId");
		expect(copilotRequestBody("list")).not.toHaveProperty("operationId");
	});

	it("keeps model and cwd on start only", () => {
		expect(copilotRequestBody("start", { prompt: "Review", model: "auto", cwd: "/work/tree" })).toMatchObject({
			model: "auto",
			cwd: "/work/tree",
		});
		expect(copilotRequestBody("message", { agentId: AGENT_ID, prompt: "x", model: "auto" })).not.toHaveProperty(
			"model",
		);
	});

	it("bounds prompts and normalizes errors", () => {
		const prompt = "x".repeat(COPILOT_PROMPT_MAX_BYTES);
		expect(CopilotStartAgentInputSchema.parse({ prompt }).prompt).toBe(prompt);
		expect(CopilotStartAgentInputSchema.safeParse({ prompt: `${prompt}x` }).success).toBe(false);

		const sanitized = sanitizeCopilotErrorText(` daemon\nfailed\u0000 ${"🙂".repeat(COPILOT_ERROR_MAX_BYTES)} `);
		expect(CopilotErrorTextSchema.safeParse(sanitized).success).toBe(true);
		expect(CopilotErrorTextSchema.safeParse(` daemon\nfailed\u0000 `).success).toBe(false);
	});

	it("rejects result states that claim impossible work", () => {
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			CopilotAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
			}).success,
		).toBe(true);
		expect(
			CopilotAgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success,
		).toBe(false);
		expect(
			CopilotAgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: { id: "turn-1", state: "completed" },
			}).success,
		).toBe(false);
		expect(
			CopilotAgentResultSchema.safeParse({
				...base,
				agentState: "recovering",
				observation: "indeterminate",
				error: { code: "indeterminate", message: "unknown", retryable: true },
				turn: { id: "turn-1", state: "inProgress" },
			}).success,
		).toBe(false);
	});
});
