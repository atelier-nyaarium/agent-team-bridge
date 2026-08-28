import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../../package.json";
import {
	AGENT_BACKENDS,
	type AgentBackendDescriptor,
	type AgentBackendId,
	agentCapabilityId,
} from "../shared/agent-backend.js";
import { isAgentBackendInstalled } from "../shared/agent-binary.js";
import { isInsideContainer } from "../shared/env.js";
import { parseSessionName } from "../shared/session-id.js";
import type { AgentDispatch } from "./agentDispatch.js";
import { registerBoardTools } from "./board/boardTools.js";
import { closeRouter, connectToRouter } from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import type { Capability } from "./capabilities.js";
import { capabilityInstructions, fetchCapabilities, hasCapability } from "./capabilities.js";
import { registerCapabilitiesTool } from "./capabilitiesTool.js";
import { registerHumanTools } from "./channel/humanTools.js";
import { gatewayDispatch as codexGatewayDispatch, registerCodexTools } from "./codex/codexTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { gatewayDispatch as copilotGatewayDispatch, registerCopilotTools } from "./copilot/copilotTools.js";
import { registerDesignerTools } from "./designer/designerTools.js";
import { registerCompactSession } from "./devcontainer/compactSession.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSetEffortLevel } from "./devcontainer/setEffortLevel.js";
import type { LocalAgentBackend } from "./local/localAgentHost.js";
import { createLocalAgentBackend } from "./local/localAgentHost.js";
import { closeReferenceSession, setReferencesEnabled } from "./references/attachRefs.js";
import { adoptHostRoots, expectHostRoots } from "./references/refWorkspace.js";
import { resolveSessionNaming } from "./team-name.js";

////////////////////////////////
//  Functions & Helpers

// An instant register loses the handshake push: the client wires its channel handler tens of ms
// after initialize completes (6-32ms observed). Only the first connect is gated; reconnects stay
// instant, since a warm client has no such race.
const INITIAL_ROUTER_CONNECT_GRACE_MS = 200;

// A backend added without a registrar fails the build.
const AGENT_TOOL_REGISTRARS: Record<AgentBackendId, (mcpServer: McpServer, dispatch: AgentDispatch) => void> = {
	codex: registerCodexTools,
	copilot: registerCopilotTools,
};

const AGENT_GATEWAY_DISPATCH: Record<AgentBackendId, AgentDispatch> = {
	codex: codexGatewayDispatch,
	copilot: copilotGatewayDispatch,
};

/** The daemon's declaration wins: it carries coordination this process cannot offer. Otherwise a
 * locally installed CLI is enough, which is what lets a Gatewayless session delegate.
 *
 * The gateway branch ALSO needs this session's binding token: the capability is a machine-wide fact,
 * the route additionally demands a per-session one, and a hand-launched session satisfies the first
 * while failing the second - registering five tools that could never succeed (issue #252). */
function registerAgentBackend(mcpServer: McpServer, backend: AgentBackendDescriptor, capabilities: Capability[]): void {
	const register = AGENT_TOOL_REGISTRARS[backend.id];
	const bound = !!process.env.SWITCHBOARD_SESSION_TOKEN;
	if (bound && hasCapability(capabilities, agentCapabilityId(backend.id))) {
		register(mcpServer, AGENT_GATEWAY_DISPATCH[backend.id]);
		return;
	}
	if (!isAgentBackendInstalled(backend)) return;

	const local = createLocalAgentBackend(backend);
	// Reaped with this session: a local agent has no daemon to outlive it.
	localBackends.push(local);
	console.error(`[${backend.id}] no daemon declared it, serving locally from the installed CLI`);
	register(mcpServer, (body) => local.handle(body));
}

const localBackends: LocalAgentBackend[] = [];

const CHANNEL_INSTRUCTIONS = `
Cross-team messages arrive as <channel source="..." ...> tags. Metadata arrives as tag attributes: session_id, from, and reply_schema when specified. The tag body is the message. Read the request and do the work.

Reply with channel_reply. Keep the usual response as a terse 1-liner receipt.
When the inbound tag carries a reply_schema, use channel_reply_structured instead.
The conversation stays open. Reply as many times as you need; there is no finality.

💠 If this was your first received message, call \`switchboard_capabilities\` to learn the channel features. If you recently compacted, call it again immediately.
`.trim();

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	const envPinned = Boolean(process.env.PROJECT_NAME);
	process.env.PROJECT_NAME = resolveSessionNaming(process.env.PROJECT_NAME, process.env.CLAUDE_CODE_SESSION_ID);
	// A session launched without the daemon's env pin registers under a DERIVED name.
	console.error(
		`[bridge] identity ${process.env.PROJECT_NAME} (${envPinned ? "env-pinned" : "derived - manual launch?"})`,
	);
	if (!process.env.BRIDGE_ROUTER_URL) {
		process.env.BRIDGE_ROUTER_URL = inContainer ? "http://switchboard:20000" : "http://localhost:20000";
	}

	const agentType = process.env.AGENT_TYPE || detectAgentType();
	const isChannel = agentType === "claude";

	// Before the server exists: it decides which tools register.
	const capabilities = await fetchCapabilities(process.env.BRIDGE_ROUTER_URL);

	const mcpServer = new McpServer(
		{ name: "switchboard", version: packageJson.version },
		isChannel
			? {
					capabilities: { experimental: { "claude/channel": {} } },
					instructions: `${CHANNEL_INSTRUCTIONS}${capabilityInstructions(capabilities)}`,
				}
			: undefined,
	);

	registerBridgeTools(mcpServer, capabilities);
	registerCapabilitiesTool(mcpServer, capabilities);
	registerReloadPlugins(mcpServer);
	registerSetEffortLevel(mcpServer);
	registerCompactSession(mcpServer);
	registerHumanTools(mcpServer, capabilities);
	// Adopted on the next start, matching the console's own restart-to-adopt.
	if (hasCapability(capabilities, "designer")) registerDesignerTools(mcpServer);
	// Reaches a child process, so the gate is whether one can be reached: a daemon, or the CLI here.
	for (const backend of AGENT_BACKENDS) registerAgentBackend(mcpServer, backend, capabilities);
	// Without the board plugin the owner cannot see or answer anything a session writes.
	if (hasCapability(capabilities, "taskboard")) registerBoardTools(mcpServer);
	// Not a tool of its own: it rides the reply path, so it is switched on rather than registered.
	setReferencesEnabled(hasCapability(capabilities, "references"));

	// Container-only. The registered name is composite; the workspace/schema key on the project alone.
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

			// Port may be held by another IDE session.
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
				`Project MCP connector is disabled. Call this tool for details.`,
				() => `Project MCP connector is disabled.

Requirements:
  - PROJECT_NAME env var must be set in the container
  - MCP_CONNECTOR_PORT (default 20002) must be exposed via compose.yml`,
			);
		}
	}

	const transport = new StdioServerTransport();
	// See INITIAL_ROUTER_CONNECT_GRACE_MS.
	mcpServer.server.oninitialized = () => {
		void adoptHostRoots(mcpServer.server);
		setTimeout(connectToRouter, INITIAL_ROUTER_CONNECT_GRACE_MS);
	};
	mcpServer.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
		await adoptHostRoots(mcpServer.server);
	});
	// Before connect: a reply racing the handshake waits for the host's roots instead of reading cwd.
	expectHostRoots();
	await mcpServer.connect(transport);

	const mode = inContainer ? "crosstalk + connector" : "crosstalk + channel";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		// The daemon is shared and stays; only this process's socket goes.
		void closeReferenceSession();
		// The only thing that ever reaps a local child: no daemon supervises it.
		for (const local of localBackends) local.shutdown();
		process.exit(0);
	});
}
