import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Capability, unionCapabilities } from "../shared/capabilities.js";
import { readCapabilities } from "./capabilities.js";

////////////////////////////////
//  Schemas

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const capabilitiesSchema: any = z.object({}).strict();

////////////////////////////////
//  Functions & Helpers

const description = `
# Switchboard Capabilities

List capabilities enabled when this session started.

Call after receiving a channel message or compacting the session.
`.trim();

/** Ids only: instruction text is served from the startup snapshot either way. */
export function describeDrift(startup: Capability[], current: Capability[] | null): string | null {
	if (!current) return null;
	const before = new Set(startup.map((c) => c.id));
	const after = new Set(current.map((c) => c.id));
	const added = [...after].filter((id) => !before.has(id)).sort();
	const removed = [...before].filter((id) => !after.has(id)).sort();
	if (added.length === 0 && removed.length === 0) return null;

	const changes = [
		...added.map((id) => `${id} is now enabled`),
		...removed.map((id) => `${id} is no longer enabled`),
	].join(", ");
	return `Changed since this session started: ${changes}. A session's tool set is fixed at startup, so restart this session to pick that up.`;
}

// Silence must not read as "checked, unchanged".
const UNVERIFIED = "Could not confirm with the gateway whether this is still current.";

export function renderCapabilities(startup: Capability[], current: Capability[] | null): string {
	const note = current === null ? UNVERIFIED : describeDrift(startup, current);
	if (startup.length === 0) {
		const lines = [`No Switchboard capabilities are enabled.`];
		if (note) lines.push("", note);
		return lines.join("\n");
	}

	const lines = [`Switchboard capabilities enabled at session start: ${startup.map((c) => c.id).join(", ")}`];
	if (note) lines.push("", note);
	lines.push("");
	for (const capability of startup) {
		lines.push(
			`## ${capability.id}`,
			"",
			capability.instructions ?? `This capability carries no guidance of its own.`,
			"",
		);
	}
	return lines.join("\n").trimEnd();
}

// The startup snapshot answers, since it is what the tool set was gated on.
export function registerCapabilitiesTool(mcpServer: McpServer, capabilities: Capability[]): void {
	mcpServer.registerTool(
		"switchboard_capabilities",
		{ title: "Switchboard Capabilities", description, inputSchema: capabilitiesSchema },
		async () => {
			const routerUrl = process.env.BRIDGE_ROUTER_URL;
			const bundle = routerUrl ? await readCapabilities(routerUrl) : null;
			// Incomplete is unverifiable, not a change: a silent source owns ids it did not report.
			const fresh = bundle && unionCapabilities(bundle);
			const current = fresh?.known ? fresh.capabilities : null;
			return { content: [{ type: "text" as const, text: renderCapabilities(capabilities, current) }] };
		},
	);
}
