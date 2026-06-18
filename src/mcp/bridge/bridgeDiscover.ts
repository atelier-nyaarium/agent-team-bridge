import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamAddress } from "../../shared/session-id.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

export function registerBridgeDiscover(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_discover",
		{
			title: "Crosstalk Discover",
			description: `List all teams on the bridge network (online and available).`,
			inputSchema: {},
		},
		async () => {
			try {
				// /discover fans out across the mesh: local teams plus every online
				// peer Gateway's teams (evie stays content-blind). Remote teams carry a
				// different `host`, shown as `host/team` so they are addressable.
				const teams = (await routerGet("/discover")) as Array<{
					team: string;
					host?: string;
					status: string;
					queue_depth: number;
					kind?: string;
				}>;
				// Consoles are the human's device, not a crosstalk peer - never advertise
				// them to agents; reach the human via the reply tools or notify_human.
				// The "host" agent is the human's control point (reached from the console),
				// not an agent crosstalk peer, so it is hidden here too.
				const others = teams.filter(
					(t) => t.team !== bridgeProjectName() && t.kind !== "console" && t.kind !== "host",
				);

				if (others.length === 0) {
					return { content: [{ type: "text" as const, text: `No other teams found.` }] };
				}

				const lines = others.map((t) => {
					const name = t.host ? TeamAddress.remote(t.host, t.team).canonical : t.team;
					if (t.status === "available") return `- ${name}: available`;
					const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
					return `- ${name}: ${status}`;
				});

				return {
					content: [{ type: "text" as const, text: `Teams on the bridge:\n${lines.join("\n")}` }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach router: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
