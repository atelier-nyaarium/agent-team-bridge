import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { debugLog } from "../shared/debug-log.js";
import { isInsideContainer } from "../shared/env.js";
import type { ChannelPushPayload } from "../shared/types.js";
import { registerBridgeDiscover } from "./bridge/bridgeDiscover.js";
import { registerBridgeSend } from "./bridge/bridgeSend.js";
import { closeRouter, connectToRouter, initBridge, setChannelServer, setIsMainOrLeadAgent } from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { emitChannelNotification } from "./channel/channelNotify.js";
import { registerHumanTools } from "./channel/humanTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerCompactSession } from "./devcontainer/compactSession.js";
import { registerDevcontainerCli } from "./devcontainer/devcontainerCli.js";
import { registerDevcontainerExec } from "./devcontainer/devcontainerExec.js";
import { registerHostSessionPeek } from "./devcontainer/hostSessionPeek.js";
import { registerHostSessionSend } from "./devcontainer/hostSessionSend.js";
import { startHostWakeListener, stopHostWakeListener } from "./devcontainer/hostWakeListener.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSessionAwaitIdle } from "./devcontainer/sessionAwaitIdle.js";
import { registerSessionPeek } from "./devcontainer/sessionPeek.js";
import { registerSessionSend } from "./devcontainer/sessionSend.js";
import { registerSetEffortLevel } from "./devcontainer/setEffortLevel.js";

////////////////////////////////
//  Functions & Helpers

const CHANNEL_INSTRUCTIONS = [
	'Cross-team messages arrive as <channel source="bridge"> tags with attributes: session_id, from, request_type, effort, is_follow_up.',
	"When you receive a channel message, read the request and do the work.",
	"When finished, call the channel_reply tool with the session_id from the tag attributes.",
].join(" ");

/** Random 6-char id for an unnamed peer session. The phone gives it a friendly label. */
function randomTeamId(): string {
	return crypto.randomBytes(3).toString("hex");
}

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	// The orchestrator is the single host session started by start-host-daemon (it sets the
	// flag); it stays the reserved, phone-hidden coordinator. Every other session is a bridge
	// peer: a devcontainer (PROJECT_NAME set) or a host/ad-hoc Claude that joins under a random
	// id the phone can rename. Peers reach the arbiter on the docker network inside a container
	// or the forwarded localhost port elsewhere.
	const isOrchestrator = !inContainer && !!process.env.SWITCHBOARD_ORCHESTRATOR;
	if (!isOrchestrator) {
		if (!process.env.PROJECT_NAME) process.env.PROJECT_NAME = randomTeamId();
		if (!process.env.BRIDGE_ROUTER_URL) {
			process.env.BRIDGE_ROUTER_URL = inContainer ? "http://switchboard:20000" : "http://localhost:20000";
		}
	}

	const agentType = isOrchestrator ? "claude" : process.env.AGENT_TYPE || detectAgentType();
	const isChannel = !isOrchestrator && agentType === "claude";

	const needsChannel = agentType === "claude";

	const mcpServer = new McpServer(
		{ name: "switchboard", version: packageJson.version },
		needsChannel
			? {
					capabilities: { experimental: { "claude/channel": {} } },
					...(isChannel ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
				}
			: undefined,
	);

	let routerAlreadyConnected = false;

	if (!isOrchestrator) {
		// Peer (devcontainer or host/ad-hoc session): crosstalk + channel reply, joined as a team.
		registerBridgeTools(mcpServer);
		registerReloadPlugins(mcpServer);
		registerSetEffortLevel(mcpServer);
		registerCompactSession(mcpServer);
		registerHumanTools(mcpServer);

		// The game-client connector serves /workspace project schemas, so it is container-only.
		if (inContainer) {
			const projectName = process.env.PROJECT_NAME;
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
	} else {
		// Host: register dispatch tools for managing containers
		registerDevcontainerCli(mcpServer);
		registerDevcontainerExec(mcpServer);
		registerSessionPeek(mcpServer);
		registerSessionSend(mcpServer);
		registerSessionAwaitIdle(mcpServer);
		registerHostSessionPeek(mcpServer);
		registerHostSessionSend(mcpServer);
		registerReloadPlugins(mcpServer);
		registerSetEffortLevel(mcpServer);
		registerCompactSession(mcpServer);

		// Init bridge for HTTP-only access (no WebSocket, just routerPost/routerGet)
		initBridge({
			routerUrl: process.env.BRIDGE_ROUTER_URL || "http://localhost:20000",
			projectName: "arbiter",
			agentType: "claude",
			effortEnv: {},
		});
		setIsMainOrLeadAgent(true);

		// Register crosstalk outgoing tools so the host can send to channel-connected containers
		registerBridgeSend(mcpServer);
		registerBridgeDiscover(mcpServer);
		registerHumanTools(mcpServer);
		setChannelServer(mcpServer.server);

		// Evie tool proxy detached (see src/mcp/evie/evieTools.ts, kept @unused for
		// history). The host still needs its router WebSocket for channel push +
		// crosstalk, so connect it directly.
		connectToRouter();
		routerAlreadyConnected = true;

		const projectDirs = [path.join(os.homedir(), "projects")];
		startHostWakeListener(projectDirs, (msg) => {
			// Fallback: if arbiter bridge is down, host daemon still delivers DMs
			const server = mcpServer.server;
			if (server) {
				emitChannelNotification(server, msg as unknown as ChannelPushPayload).catch((err: Error) => {
					console.error(`[host-wake] channel notification error: ${err.message}`);
				});
			}
		});
		console.error(`[mcp] dispatch + crosstalk tools enabled (host mode)`);
	}

	// #region Hypothesis S: transport connection timing relative to evie registration
	debugLog("S", "src/mcp/index.ts:transport", "connecting stdio transport", {
		inContainer,
		routerAlreadyConnected,
	});
	// #endregion
	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	// Container always connects after transport (no evie tools to wait for).
	// Host connects here only if evie tools arrived via HTTP probe (the slow
	// path above already connected the WebSocket when the probe failed).
	if (!routerAlreadyConnected) {
		connectToRouter();
	}

	const mode = inContainer
		? isChannel
			? "channel + crosstalk + connector"
			: "cli + crosstalk + connector"
		: "dispatch + crosstalk + channel";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		stopHostWakeListener();
		process.exit(0);
	});
}
