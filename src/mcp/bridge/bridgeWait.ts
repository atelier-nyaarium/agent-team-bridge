import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

////////////////////////////////
//  Schemas

const BridgeWaitSchema = z.object({
	seconds: z.number().min(1).max(1800),
});
type BridgeWaitArgs = z.infer<typeof BridgeWaitSchema>;

////////////////////////////////
//  Functions & Helpers

export function registerBridgeWait(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_wait",
		{
			title: `Crosstalk Wait`,
			description: `Wait before retrying when another team asks.`,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: BridgeWaitSchema as any,
		},
		async ({ seconds }: BridgeWaitArgs) => {
			await new Promise((r) => setTimeout(r, seconds * 1000));
			return { content: [{ type: "text" as const, text: `Waited ${seconds}s. You can retry now.` }] };
		},
	);
}
