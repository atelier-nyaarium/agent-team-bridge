import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

	it("registers both with the capabilities actually fetched, not a default", () => {
		// The default parameter exists so a test can construct one bare, and would silently give a real
		// session an empty description if a call site forgot to pass through.
		const index = fs.readFileSync(path.join(MCP, "index.ts"), "utf8");

		expect(index).toContain("registerBridgeTools(mcpServer, capabilities)");
		expect(index).toContain("registerHumanTools(mcpServer, capabilities)");
	});
});
