import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { capabilityInstructions, GATED_CAPABILITY_IDS } from "../mcp/capabilities.js";
import { renderCapabilities } from "../mcp/capabilitiesTool.js";
import { registerChannelReply } from "../mcp/channel/channelReply.js";
import { registerHumanTools } from "../mcp/channel/humanTools.js";
import { scanRefs } from "../mcp/references/refScanner.js";
import type { Capability } from "../shared/capabilities.js";

////////////////////////////////
//  Functions & Helpers

// A tool whose body is scanned for refs has to reach an agent with where the ref grammar lives. Only
// a tool description rides along with every request, so that is the surface the pointer belongs on.
const MCP = path.join(import.meta.dirname, "..", "mcp");

const SURFACES = [
	["channel_reply", path.join(MCP, "channel", "channelReply.ts")],
	["notify_human", path.join(MCP, "channel", "humanTools.ts")],
] as const;

function referencesCapability(): { id: string; instructions: string } {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(
				MCP,
				"..",
				"..",
				"android",
				"app",
				"src",
				"main",
				"assets",
				"plugins",
				"references",
				"manifest.json",
			),
			"utf8",
		),
	);
	return { id: "references", instructions: String(manifest.agent_instructions) };
}

////////////////////////////////
//  Tests

describe("every tool whose body is scanned for refs", () => {
	it.each(SURFACES)("%s scans the body", (_name, file) => {
		expect(fs.readFileSync(file, "utf8")).toContain("appendRefArtifacts");
	});

	it.each(SURFACES)("%s appends the enabled-capability note to its description", (_name, file) => {
		expect(fs.readFileSync(file, "utf8")).toContain("capabilityInstructions(capabilities)");
	});

	it("registers both with the capabilities actually fetched, not a default", () => {
		// The default parameter exists so a test can construct one bare, and would silently give a real
		// session an empty description if a call site forgot to pass through.
		const index = fs.readFileSync(path.join(MCP, "index.ts"), "utf8");

		expect(index).toContain("registerBridgeTools(mcpServer, capabilities)");
		expect(index).toContain("registerHumanTools(mcpServer, capabilities)");
		// The last hop of the chain. Passed an empty list, the tool answers that nothing is enabled
		// while the descriptions still point an agent at it.
		expect(index).toContain("registerCapabilitiesTool(mcpServer, capabilities)");
		expect(index).toContain("capabilityInstructions(capabilities)");
	});
});

describe("the path from a scanned tool to the ref grammar", () => {
	// Each hop asserted on its own output rather than on source text, since a call site can keep
	// calling the same helper after that helper has stopped carrying what the caller needs.
	it("names the capability and sends the agent to the tool", () => {
		const note = capabilityInstructions([referencesCapability()]);

		expect(note).toContain("references");
		expect(note).toContain("switchboard_capabilities");
	});

	it("ends at a tool that serves the grammar and its worked examples", () => {
		const served = renderCapabilities([referencesCapability()], null);
		const { refs, problems } = scanRefs(served);

		expect(problems).toEqual([]);
		expect(refs.length).toBeGreaterThan(5);
	});

	it("teaches examples the parser actually accepts", () => {
		// The guidance IS the contract an agent writes against, so a worked example that no longer
		// parses teaches a format the implementation rejects, and the agent finds out by having a send
		// hard-fail, or worse by a near-miss that is skipped in silence.
		const { refs, problems } = scanRefs(referencesCapability().instructions);

		expect(problems).toEqual([]);
		expect(refs.length).toBeGreaterThan(5);
	});

	it("still reaches the grammar when the guidance is the only thing served", () => {
		// The note carries names alone, so an agent that never calls the tool has no grammar at all.
		// That is the trade, and it only holds if the tool genuinely serves the whole manifest text.
		const { refs, problems } = scanRefs(renderCapabilities([referencesCapability()], null));

		expect(problems).toEqual([]);
		expect(refs.length).toBeGreaterThan(5);
	});
});

describe("what a tool description costs", () => {
	// Every request carries these, and the guidance is appended to them, so growth on either side is
	// paid on every turn.
	const BUDGET = 2048;

	function described(register: (server: McpServer, capabilities: Capability[]) => void): string[] {
		const seen: string[] = [];
		const collector = {
			registerTool: (_name: string, config: { description?: string }) => {
				seen.push(config.description ?? "");
			},
		};
		register(collector as unknown as McpServer, GATED_CAPABILITY_IDS.map((id) => ({ id })) as Capability[]);
		return seen;
	}

	it.each([
		["channel_reply", registerChannelReply],
		["notify_human", registerHumanTools],
	])("keeps %s under the budget with every capability on", (_name, register) => {
		const descriptions = described(register as (server: McpServer, capabilities: Capability[]) => void);

		expect(descriptions.length).toBeGreaterThan(0);
		for (const description of descriptions) {
			expect(description).toContain("Artifact refs");
			expect(description.length).toBeLessThanOrEqual(BUDGET);
		}
	});
});
