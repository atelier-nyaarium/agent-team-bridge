import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRefs } from "../mcp/references/refScanner.js";

////////////////////////////////
//  Functions & Helpers

/**
 * A tool whose body is scanned for refs has to say how to write one.
 *
 * `notify_human` scanned refs for as long as the feature existed and its description never mentioned
 * them, so an agent writing a notice had the grammar only in the server instructions, read once at
 * session start and far away by the time it matters. That is also the only copy a compaction cannot
 * re-present, since a tool description rides along with every request and a remembered rule does not.
 * This pins the pair: scan the body, teach the format.
 */
const MCP = path.join(import.meta.dirname, "..", "mcp");

const SURFACES = [
	["channel_reply", path.join(MCP, "channel", "channelReply.ts")],
	["notify_human", path.join(MCP, "channel", "humanTools.ts")],
] as const;

////////////////////////////////
//  Tests

describe("every tool whose body is scanned for refs", () => {
	it.each(SURFACES)("%s scans the body", (_name, file) => {
		expect(fs.readFileSync(file, "utf8")).toContain("appendRefArtifacts");
	});

	it.each(SURFACES)("%s carries the plugin's own guidance in its description", (_name, file) => {
		expect(fs.readFileSync(file, "utf8")).toContain("capabilityInstructions(capabilities)");
	});

	it("teaches examples the parser actually accepts", () => {
		// The guidance IS the contract an agent writes against, so a worked example that no longer
		// parses teaches a format the implementation rejects - and the agent finds out by having a send
		// hard-fail, or worse by a near-miss that is skipped in silence.
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
		// Scanned exactly as a real message body would be, so the examples are read by the same
		// markdown parser and the same grammar that decide what an agent's own ref means.
		const { refs, problems } = scanRefs(String(manifest.agent_instructions));

		expect(problems).toEqual([]);
		expect(refs.length).toBeGreaterThan(5);
	});

	it("registers both with the capabilities actually fetched, not a default", () => {
		// The default parameter exists so a test can construct one bare, and would silently give a real
		// session an empty description if a call site forgot to pass through.
		const index = fs.readFileSync(path.join(MCP, "index.ts"), "utf8");

		expect(index).toContain("registerBridgeTools(mcpServer, capabilities)");
		expect(index).toContain("registerHumanTools(mcpServer, capabilities)");
	});
});
