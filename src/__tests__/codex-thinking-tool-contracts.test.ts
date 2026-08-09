import { describe, expect, it } from "vitest";
import {
	CODEX_ACTIVITY_MAX_BYTES,
	CODEX_ERROR_MAX_BYTES,
	CODEX_PROMPT_MAX_BYTES,
	CodexActivitySchema,
	CodexAgentResultSchema,
	CodexErrorTextSchema,
	CodexGatewayRequestSchema,
	CodexRequestErrorSchema,
	CodexStartAgentInputSchema,
	sanitizeCodexErrorText,
} from "../shared/codex-thinking.js";
import { AGENT_ID, OPERATION_ID } from "./helpers/codex-thinking.js";

describe("Codex tool contracts", () => {
	it("rejects private or unknown tool fields", () => {
		expect(CodexStartAgentInputSchema.parse({ prompt: "Review this" })).toEqual({ prompt: "Review this" });
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "Review", operationId: OPERATION_ID }).success).toBe(
			false,
		);
		expect(CodexGatewayRequestSchema.safeParse({ kind: "start", prompt: "Review" }).success).toBe(false);
	});

	it.each([
		{ kind: "start", operationId: OPERATION_ID, prompt: "Review" },
		{ kind: "message", operationId: OPERATION_ID, agentId: AGENT_ID, prompt: "Continue" },
		{ kind: "await", agentId: AGENT_ID },
		{ kind: "stop", operationId: OPERATION_ID, agentId: AGENT_ID },
		{ kind: "list" },
	])("accepts the private gateway $kind request", (request) => {
		expect(CodexGatewayRequestSchema.safeParse(request).success).toBe(true);
	});

	it("bounds prompts by encoded bytes without altering their text", () => {
		const boundary = "x".repeat(CODEX_PROMPT_MAX_BYTES);
		const emoji = "\u{1F600}";
		const multibyteBoundary = emoji.repeat(CODEX_PROMPT_MAX_BYTES / 4);
		expect(CodexStartAgentInputSchema.parse({ prompt: boundary }).prompt).toBe(boundary);
		expect(CodexStartAgentInputSchema.parse({ prompt: multibyteBoundary }).prompt).toBe(multibyteBoundary);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: `${boundary}x` }).success).toBe(false);
		expect(
			CodexStartAgentInputSchema.safeParse({ prompt: emoji.repeat(CODEX_PROMPT_MAX_BYTES / 4 + 1) }).success,
		).toBe(false);
		expect(CodexStartAgentInputSchema.safeParse({ prompt: "  \n" }).success).toBe(false);
	});

	it("normalizes untrusted errors before they cross protocol or persistence boundaries", () => {
		const raw = `  daemon\nfailed\u0000 with\u200b detail ${"🙂".repeat(CODEX_ERROR_MAX_BYTES)}  `;
		const sanitized = sanitizeCodexErrorText(raw);

		expect(sanitized).toBe(sanitizeCodexErrorText(sanitized));
		expect(sanitized).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u);
		expect(new TextEncoder().encode(sanitized).byteLength).toBeLessThanOrEqual(CODEX_ERROR_MAX_BYTES);
		expect(CodexErrorTextSchema.safeParse(sanitized).success).toBe(true);
		expect(CodexErrorTextSchema.safeParse(raw).success).toBe(false);
	});

	it("rejects contradictory result observations and misplaced truncation markers", () => {
		const inProgress = { id: "turn-1", state: "inProgress" };
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: inProgress,
				delivery: "started",
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: { id: "turn-1", state: "completed" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: inProgress,
				activities: [{ kind: "truncated", omitted: 2 }],
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: inProgress,
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "unavailable",
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "waitTimedOut",
				turn: inProgress,
				activities: [
					{ kind: "truncated", omitted: 2 },
					{ kind: "commentary", text: "later" },
				],
			}).success,
		).toBe(false);
	});

	it("represents a creation timeout without inventing a native turn", () => {
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "creating",
				observation: "waitTimedOut",
				activities: [],
			}).success,
		).toBe(true);
	});

	it("bounds individual commentary before it reaches a result", () => {
		expect(
			CodexActivitySchema.safeParse({
				kind: "commentary",
				text: "x".repeat(CODEX_ACTIVITY_MAX_BYTES + 1),
			}).success,
		).toBe(false);
	});

	it("keeps accepted delivery and terminal output tied to a native turn", () => {
		const completed = {
			agentId: AGENT_ID,
			agentState: "idle",
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			delivery: "started",
			activities: [{ kind: "commentary", text: "Checking" }],
			finalResponse: "Done",
		};
		expect(CodexAgentResultSchema.safeParse(completed).success).toBe(true);
		expect(CodexAgentResultSchema.safeParse({ ...completed, finalResponse: undefined }).success).toBe(false);
		expect(CodexAgentResultSchema.safeParse({ ...completed, turn: undefined }).success).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({ ...completed, turn: { id: "turn-1", state: "failed" } }).success,
		).toBe(false);
	});

	it("represents stable rejection and interrupt-pending errors", () => {
		const error = { message: "Unavailable", retryable: false };
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "interruptRequested",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "interrupt_in_progress" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "unavailable",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "not_found" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "creating",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "feature_disabled" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "interrupt_in_progress" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				activities: [],
				error: { ...error, code: "not_found" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "unavailable",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
				activities: [],
				error: { ...error, code: "feature_disabled" },
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "working",
				observation: "interruptRequested",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "steered",
				activities: [],
			}).success,
		).toBe(false);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "recovering",
				observation: "indeterminate",
				activities: [],
				error: { ...error, code: "indeterminate" },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "idle",
				observation: "indeterminate",
				turn: { id: "turn-1", state: "completed" },
				delivery: "started",
				activities: [],
				error: { ...error, code: "indeterminate" },
			}).success,
		).toBe(false);
		expect(
			CodexRequestErrorSchema.safeParse({
				error: { code: "invalid_input", message: "Prompt is blank", retryable: false },
			}).success,
		).toBe(true);
		expect(
			CodexAgentResultSchema.safeParse({
				agentId: AGENT_ID,
				agentState: "unavailable",
				observation: "unavailable",
				activities: [],
				error: { ...error, code: "invalid_input" },
			}).success,
		).toBe(false);
	});
});
