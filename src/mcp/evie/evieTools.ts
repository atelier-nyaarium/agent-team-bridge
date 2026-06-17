import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EvieToolCallResult, EvieToolSchema } from "../../arbiter/evie/evieClient.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

// @unused - DETACHED. The evie tool proxy is no longer wired into the host MCP:
// src/mcp/index.ts dropped the acquisition block, so nothing imports this. Kept
// for history. The human now reaches agents through the console channel and
// notify_human, not evie's Discord tool registry. Re-attach by restoring the
// evie-tool acquisition block in mcp/index.ts.

/**
 * Register evie's action registry tools as MCP tools on the host.
 * Called when the evie client receives the tool_registry message.
 * Tools are prefixed with "evie_" to avoid name collisions.
 */
export function registerEvieTools(mcpServer: McpServer, tools: EvieToolSchema[]): void {
	for (const tool of tools) {
		// post_response is replaced by the arbiter-owned respond_to_human tool.
		if (tool.name === "post_response") continue;

		const mcpName = `evie_${tool.name.replace(/-/g, "_")}`;

		const zodSchema = z.fromJSONSchema(tool.parameters);

		mcpServer.registerTool(
			mcpName,
			{
				title: `Evie: ${tool.title}`,
				description: `[evie-bot] ${tool.description}`,
				// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
				inputSchema: zodSchema as any,
			},
			async (args: Record<string, unknown>) => {
				try {
					const response = (await routerPost("/evie/tool-call", {
						action: tool.name,
						params: args,
					})) as EvieToolCallResult;

					if (response.error) {
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify({ error: response.error }, null, 2) },
							],
							isError: true,
						};
					}

					const resultText =
						typeof response.result === "string"
							? response.result
							: JSON.stringify(response.result, null, 2);

					return {
						content: [{ type: "text" as const, text: resultText }],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: (error as Error).message }, null, 2),
							},
						],
						isError: true,
					};
				}
			},
		);
	}

	console.error(`[evie-tools] registered ${tools.length} tools from evie-bot`);
}
