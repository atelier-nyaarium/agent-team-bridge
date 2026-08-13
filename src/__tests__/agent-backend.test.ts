import { describe, expect, it } from "vitest";
import {
	AGENT_BACKENDS,
	agentCapabilityId,
	agentEnvPrefix,
	agentFrameType,
	agentHttpPath,
	agentInboundFrameTypes,
	CODEX_BACKEND,
	COPILOT_BACKEND,
} from "../shared/agent-backend.js";
import { CODEX_THINKING_CAPABILITY_ID, COPILOT_THINKING_CAPABILITY_ID } from "../shared/capabilities.js";
import { CODEX_WAIT_BUDGET_MS, CodexDaemonHelloSchema, CodexEventAckSchema } from "../shared/codex-thinking.js";
import { COPILOT_WAIT_BUDGET_MS, CopilotDaemonHelloSchema, CopilotEventAckSchema } from "../shared/copilot-thinking.js";

// Every derivation is pinned so a descriptor edit that would change a wire spelling fails here instead of at a peer.
describe("agent backend derivations", () => {
	it("derives the capability ids the gates read", () => {
		expect(agentCapabilityId("codex")).toBe(CODEX_THINKING_CAPABILITY_ID);
		expect(agentCapabilityId("copilot")).toBe(COPILOT_THINKING_CAPABILITY_ID);
		expect(CODEX_THINKING_CAPABILITY_ID).toBe("codex-thinking");
		expect(COPILOT_THINKING_CAPABILITY_ID).toBe("copilot-thinking");
	});

	it("derives the env prefixes the child-env scrub exempts", () => {
		expect(agentEnvPrefix("codex")).toBe("CODEX_");
		expect(agentEnvPrefix("copilot")).toBe("COPILOT_");
	});

	it("derives the HTTP paths the tools post to", () => {
		expect(agentHttpPath("codex")).toBe("/codex");
		expect(agentHttpPath("copilot")).toBe("/copilot");
	});

	it("derives frame types the wire schemas accept", () => {
		const codexHello = {
			type: agentFrameType("codex", "hello"),
			daemonInstanceId: "daemon-1",
			targets: [],
		};
		expect(CodexDaemonHelloSchema.safeParse(codexHello).success).toBe(true);
		const copilotHello = { ...codexHello, type: agentFrameType("copilot", "hello") };
		expect(CopilotDaemonHelloSchema.safeParse(copilotHello).success).toBe(true);

		const codexAck = {
			type: agentFrameType("codex", "ack"),
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			throughEventId: 0,
		};
		expect(CodexEventAckSchema.safeParse(codexAck).success).toBe(true);
		const copilotAck = { ...codexAck, type: agentFrameType("copilot", "ack") };
		expect(CopilotEventAckSchema.safeParse(copilotAck).success).toBe(true);
	});

	it("lists exactly the daemon-to-gateway frame types", () => {
		expect([...agentInboundFrameTypes("codex")].sort()).toEqual(["codex_event", "codex_hello", "codex_receipt"]);
		expect([...agentInboundFrameTypes("copilot")].sort()).toEqual([
			"copilot_event",
			"copilot_hello",
			"copilot_receipt",
		]);
	});

	it("keeps the wait budget the tools document", () => {
		expect(CODEX_BACKEND.waitBudgetMs).toBe(240_000);
		expect(COPILOT_BACKEND.waitBudgetMs).toBe(240_000);
		expect(CODEX_WAIT_BUDGET_MS).toBe(CODEX_BACKEND.waitBudgetMs);
		expect(COPILOT_WAIT_BUDGET_MS).toBe(COPILOT_BACKEND.waitBudgetMs);
	});

	it("registers each backend exactly once", () => {
		expect(AGENT_BACKENDS.map((backend) => backend.id)).toEqual(["codex", "copilot"]);
	});
});
