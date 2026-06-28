import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { isInsideContainer } from "../shared/env.js";
import { composeSessionName, isComposite, parseSessionName } from "../shared/session-id.js";
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
import { randomTeamId, stableTeamName } from "./team-name.js";

////////////////////////////////
//  Functions & Helpers

const CHANNEL_INSTRUCTIONS = [
	'Cross-team messages arrive as <channel source="bridge"> tags with attributes: session_id, from, request_type, effort, is_follow_up.',
	"When you receive a channel message, read the request and do the work.",
	"When finished, call the channel_reply tool with the session_id from the tag attributes.",
].join(" ");

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	// Every session is a bridge peer: a devcontainer (PROJECT_NAME set) or a host/ad-hoc Claude that
	// joins under a STABLE per-session name derived from the harness session id, so a reload /
	// restart+resume re-registers the same name and the phone thread resumes. A missing session id
	// falls back to a fresh random name. Peers reach the gateway on the docker network inside a
	// container or the forwarded localhost port elsewhere. The host plumbing (wake + terminal view)
	// lives in the headless host daemon, not here.
	// Every LIVE registrant is an addressable chat, so it must register a COMPOSITE (arity-2) name; a
	// bare arity-1 name is reserved for catalog spawn-points only (the load-bearing invariant of the
	// address grammar). An unset PROJECT_NAME joins under the host spawn-point; a set-but-BARE one
	// (image ENV, manual/VS-Code-direct launch) is normalized to a session under that spawn. A name
	// already composite (the daemon's `project.session`) is used as-is.
	const explicitProject = process.env.PROJECT_NAME;
	if (!explicitProject) {
		const adhoc = stableTeamName(process.env.CLAUDE_CODE_SESSION_ID) ?? randomTeamId();
		process.env.PROJECT_NAME = composeSessionName("host", adhoc);
	} else if (!isComposite(explicitProject)) {
		const adhoc = stableTeamName(process.env.CLAUDE_CODE_SESSION_ID) ?? randomTeamId();
		process.env.PROJECT_NAME = composeSessionName(explicitProject, adhoc);
	}
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
