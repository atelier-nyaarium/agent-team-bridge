import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { isInsideContainer } from "../shared/env.js";
import { parseSessionName } from "../shared/session-id.js";
import { closeRouter, connectToRouter } from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { registerHumanTools } from "./channel/humanTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerCompactSession } from "./devcontainer/compactSession.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSetEffortLevel } from "./devcontainer/setEffortLevel.js";
import { resolveSessionNaming } from "./team-name.js";

////////////////////////////////
//  Functions & Helpers

const CHANNEL_INSTRUCTIONS = [
	'Cross-team messages arrive as <channel source="..." ...> tags. ALL metadata rides as tag attributes (session_id, from, and reply_schema when the request specifies one); the tag body is the message itself, nothing is jammed into it.',
	"Read the request and do the work.",
	"Reply with the channel_reply tool: pass the session_id from the tag attributes and put your prose in respondAsMarkdownString (renders as markdown + mermaid for the human); use respondAsStructuredData only when the tag carries a reply_schema. The conversation stays open, so you may reply multiple times (interim updates, etc.) with no finality.",
	"For a substantial reply you may also pass an optional title (a one-line headline) and summary (a few sentences); the console shows the title in its notification bar and uses the tiers for text-to-speech. Omit them for short or plain replies.",
].join(" ");

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	// Every session is a bridge peer registering under a composite `spawn.session` name from
	// resolveSessionNaming (see team-name.ts for the composition rules). Peers reach the gateway on
	// the docker network inside a container or the forwarded localhost port elsewhere. The host
	// plumbing (wake + terminal view) lives in the headless host daemon, not here.
	process.env.PROJECT_NAME = resolveSessionNaming(
		process.env.PROJECT_NAME,
		process.env.CLAUDE_CODE_SESSION_ID,
	).projectName;
	if (!process.env.BRIDGE_ROUTER_URL) {
		process.env.BRIDGE_ROUTER_URL = inContainer ? "http://switchboard:20000" : "http://localhost:20000";
	}

	const agentType = process.env.AGENT_TYPE || detectAgentType();
	const isChannel = agentType === "claude";

	const mcpServer = new McpServer(
		{ name: "switchboard", version: packageJson.version },
		isChannel
			? {
					capabilities: { experimental: { "claude/channel": {} } },
					instructions: CHANNEL_INSTRUCTIONS,
				}
			: undefined,
	);

	registerBridgeTools(mcpServer);
	registerReloadPlugins(mcpServer);
	registerSetEffortLevel(mcpServer);
	registerCompactSession(mcpServer);
	registerHumanTools(mcpServer);

	// The game-client connector serves /workspace project schemas, so it is container-only. The
	// registered name is composite (`project.session`); the workspace dir + schema are keyed by the
	// PROJECT (spawn) segment, so resolve that, not the full session name.
	if (inContainer) {
		const projectName = process.env.PROJECT_NAME ? parseSessionName(process.env.PROJECT_NAME).project : undefined;
		const port = Number(process.env.MCP_CONNECTOR_PORT) || 20002;

		if (projectName) {
			const connectorDir = `/workspace/${projectName}/.claude/connector`;

			const tokenPath = `${connectorDir}/token`;
			if (fs.existsSync(tokenPath)) {
				setAuthToken(fs.readFileSync(tokenPath, "utf-8").trim());
				console.error(`[connector] Auth token loaded`);
			}

			// Best-effort start - port may be held by another IDE session
			try {
				startListener(port);
			} catch {
				console.error(`[connector] port ${port} in use, connector managed by another session`);
			}

			registerConnectorTools(mcpServer, projectName, connectorDir, port);
			await registerProjectTools(mcpServer, projectName, connectorDir);
		} else {
			registerStubTool(
				mcpServer,
				"projectMcpConnectorStatus",
				"Project MCP connector is disabled. Call this tool for details.",
				() =>
					[
						"Project MCP connector is disabled.",
						"",
						"Requirements:",
						"  - PROJECT_NAME env var must be set in the container",
						"  - MCP_CONNECTOR_PORT (default 20002) must be exposed via compose.yml",
					].join("\n"),
			);
		}
	}

	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);
	connectToRouter();

	const mode = inContainer ? "crosstalk + connector" : "crosstalk + channel";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		process.exit(0);
	});
}
