import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChannelReply } from "../channel/channelReply.js";
import { registerBridgeDiscover } from "./bridgeDiscover.js";
import { registerBridgeSend } from "./bridgeSend.js";
import { registerBridgeWait } from "./bridgeWait.js";
import { initBridge, setChannelServer } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

const AGENT_CLI_NAMES: Record<string, string> = {
	claude: "claude",
	cursor: "cursor-agent",
	copilot: "copilot",
	codex: "codex",
};

export function detectAgentType(): string {
	for (const [agentType, cli] of Object.entries(AGENT_CLI_NAMES)) {
		try {
			execSync(`which ${cli}`, { stdio: "ignore" });
			return agentType;
		} catch {
			// Not found, try next
		}
	}
	return "claude";
}

export function registerBridgeTools(mcpServer: McpServer): void {
	const projectName = process.env.PROJECT_NAME;

	if (!projectName) {
		// Register tools that return config error so agents see the tools exist but get a clear message
		const configError = {
			content: [
				{
					type: "text" as const,
					text: `Bridge is not configured. The PROJECT_NAME environment variable is missing from this container's devcontainer config.`,
				},
			],
			isError: true,
		};
		mcpServer.registerTool(
			"crosstalk_discover",
			{
				title: "Crosstalk Discover",
				description: `[Disabled] List all active teams on the bridge network.`,
				inputSchema: {},
			},
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_send",
			{ title: "Crosstalk Send", description: `[Disabled] Send a request to another team.`, inputSchema: {} },
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_reply",
			{
				title: "Crosstalk Reply",
				description: `[Disabled] Reply to an incoming bridge request.`,
				inputSchema: {},
			},
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_wait",
			{ title: "Crosstalk Wait", description: `[Disabled] Wait N seconds before retrying.`, inputSchema: {} },
			async () => configError,
		);
		return;
	}

	const agentType = process.env.AGENT_TYPE || detectAgentType();

	initBridge({
		routerUrl: process.env.BRIDGE_ROUTER_URL || "http://switchboard:20000",
		projectName,
		agentType,
	});

	// Shared outgoing tools (all agents)
	registerBridgeDiscover(mcpServer);
	registerBridgeSend(mcpServer);
	registerBridgeWait(mcpServer);

	registerChannelReply(mcpServer);
	setChannelServer(mcpServer.server);
	console.error(`[bridge] channel mode, channel_reply registered`);
}
