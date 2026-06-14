import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
				const teams = (await routerGet("/teams")) as Array<{
					team: string;
					status: string;
					queue_depth: number;
					kind?: string;
				}>;
				// Phones are the human's device, not a crosstalk peer - never advertise
				// them to agents; reach the human via the reply tools or notify_human.
				// The "host" agent is the human's control point (reached from the phone),
				// not an agent crosstalk peer, so it is hidden here too.
				const others = teams.filter(
					(t) => t.team !== bridgeProjectName() && t.kind !== "phone" && t.kind !== "host",
				);

				if (others.length === 0) {
					return { content: [{ type: "text" as const, text: `No other teams found.` }] };
				}

				const lines = others.map((t) => {
					if (t.status === "available") return `- ${t.team}: available`;
					const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
					return `- ${t.team}: ${status}`;
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
