import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Capability } from "../capabilities.js";
import { registerChannelReply, registerChannelReplyStructured } from "../channel/channelReply.js";
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

const DISABLED_TOOLS: Array<{ name: string; title: string; description: string }> = [
	{
		name: "crosstalk_discover",
		title: "Crosstalk Discover",
		description: `List reachable bridge teams.`,
	},
	{ name: "crosstalk_send", title: "Crosstalk Send", description: `Send a request to another team.` },
	{ name: "crosstalk_wait", title: "Crosstalk Wait", description: `Wait before retrying.` },
	{ name: "channel_reply", title: "Channel Reply", description: `Reply to an incoming channel message.` },
	{
		name: "channel_reply_structured",
		title: "Channel Reply (Structured)",
		description: `Reply to a request with \`reply_schema\`.`,
	},
];

export function registerBridgeTools(mcpServer: McpServer, capabilities: Capability[] = []): void {
	const projectName = process.env.PROJECT_NAME;

	if (!projectName) {
		// Keep 1:1 with the branch below, so a misconfigured container still shows every tool.
		const configError = {
			content: [
				{
					type: "text" as const,
					text: `Bridge is not configured. The PROJECT_NAME environment variable is missing from this container's devcontainer config.`,
				},
			],
			isError: true,
		};
		for (const tool of DISABLED_TOOLS) {
			mcpServer.registerTool(
				tool.name,
				{ title: tool.title, description: `[Disabled] ${tool.description}`, inputSchema: {} },
				async () => configError,
			);
		}
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

	registerChannelReply(mcpServer, capabilities);
	registerChannelReplyStructured(mcpServer);
	setChannelServer(mcpServer.server);
	console.error(`[bridge] channel mode, channel_reply + channel_reply_structured registered`);
}
