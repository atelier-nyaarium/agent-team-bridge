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
What Switchboard capabilities this session has, and the guidance each one carries. Call once to understand their features, and again immediately after a context compaction.
`.trim();

/** What changed since startup, in ids alone. Instruction text is served from the startup snapshot
 * either way, so a reworded manifest is not something a caller can act on. */
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

// Silence would otherwise mean both "checked, unchanged" and "could not check", which are different
// answers from the one surface whose whole job is to be authoritative about what this session has.
const UNVERIFIED = "Could not confirm with the gateway whether this is still current.";

export function renderCapabilities(startup: Capability[], current: Capability[] | null): string {
	const note = current === null ? UNVERIFIED : describeDrift(startup, current);
	if (startup.length === 0) {
		return ["No Switchboard capabilities are enabled.", ...(note ? ["", note] : [])].join("\n");
	}

	const sections = startup.map((c) =>
		[`## ${c.id}`, "", c.instructions ?? "This capability carries no guidance of its own."].join("\n"),
	);
	return [
		`Switchboard capabilities enabled at session start: ${startup.map((c) => c.id).join(", ")}`,
		...(note ? ["", note] : []),
		"",
		...sections.flatMap((s) => [s, ""]),
	]
		.join("\n")
		.trimEnd();
}

// Ungated: the always-on block points here unconditionally, and this is what explains an absence.
// The startup snapshot answers, since it is what the tool set was gated on. A fresh read only ever
// adds a drift warning, because serving it as the answer would describe tools this session lacks.
export function registerCapabilitiesTool(mcpServer: McpServer, capabilities: Capability[]): void {
	mcpServer.registerTool(
		"switchboard_capabilities",
		{ title: "Switchboard Capabilities", description, inputSchema: capabilitiesSchema },
		async () => {
			const routerUrl = process.env.BRIDGE_ROUTER_URL;
			const bundle = routerUrl ? await readCapabilities(routerUrl) : null;
			// An incomplete answer is unverifiable, not evidence of a change: the silent source owns ids
			// it did not report, and comparing against it would name them as newly disabled.
			const fresh = bundle && unionCapabilities(bundle);
			const current = fresh?.known ? fresh.capabilities : null;
			return { content: [{ type: "text" as const, text: renderCapabilities(capabilities, current) }] };
		},
	);
}
