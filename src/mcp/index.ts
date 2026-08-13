import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { setReferencesEnabled } from "./references/attachRefs.js";
import { resolveSessionNaming } from "./team-name.js";

////////////////////////////////
//  Functions & Helpers

// Grace between the client's initialized signal and the FIRST router connect. The gateway pushes a
// lead handshake within microseconds of the bridge registering, but the client wires its channel
// notification handler tens of ms AFTER the MCP initialize completes - an instant register loses
// that race and the push is dropped unheard (observed 6-32ms margins on a localhost gateway). Only
// the first connect is gated; WS reconnects (helpers.ts's reconnector) stay instant, since a warm
// client has no such race.
const INITIAL_ROUTER_CONNECT_GRACE_MS = 200;

// Keyed by the backend union, so a backend added to the registry without a registrar fails the build.
const AGENT_TOOL_REGISTRARS: Record<AgentBackendId, (mcpServer: McpServer, dispatch: AgentDispatch) => void> = {
	codex: registerCodexTools,
	copilot: registerCopilotTools,
};

const AGENT_GATEWAY_DISPATCH: Record<AgentBackendId, AgentDispatch> = {
	codex: codexGatewayDispatch,
	copilot: copilotGatewayDispatch,
};

/**
 * Register one backend's tools, if this session can reach it at all, and answer how.
 *
 * The daemon's declaration wins wherever it exists: it carries coordination this process cannot
 * offer, and its agents outlive the session. Otherwise a locally installed CLI is enough on its own,
 * which is what makes a Gatewayless session able to delegate. Installing the CLI is the whole opt-in
 * either way; nothing here reads a flag.
 */
function registerAgentBackend(mcpServer: McpServer, backend: AgentBackendDescriptor, capabilities: Capability[]): void {
	const register = AGENT_TOOL_REGISTRARS[backend.id];
	if (hasCapability(capabilities, agentCapabilityId(backend.id))) {
		register(mcpServer, AGENT_GATEWAY_DISPATCH[backend.id]);
		return;
	}
	if (!isAgentBackendInstalled(backend)) return;

	const local = createLocalAgentBackend(backend);
	// Reaped with the session that started it. A local agent has no daemon to outlive it, so a child
	// left behind here would be one nothing can ever reach or stop again.
	localBackends.push(local);
	console.error(`[${backend.id}] no daemon declared it, serving locally from the installed CLI`);
	register(mcpServer, (body) => local.handle(body));
}

const localBackends: LocalAgentBackend[] = [];

const CHANNEL_INSTRUCTIONS = `
Cross-team messages arrive as <channel source="..." ...> tags. All metadata rides as tag attributes: session_id, from, and reply_schema when the request specifies one. The tag body is the message. Read the request and do the work.

Reply with the channel_reply tool, and keep your usual stout response a terse 1-liner as a receipt.
When the inbound tag carries a reply_schema, use channel_reply_structured instead.
The conversation stays open. Reply as many times as you need; there is no finality.

💠 If this was your first received message, call \`switchboard_capabilities\` to understand the channel features. If you recently compacted, call it again immediately.
`.trim();

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	// Every session is a bridge peer registering under a composite `spawn.session` name from
	// resolveSessionNaming (see team-name.ts for the composition rules). Peers reach the gateway on
	// the docker network inside a container or the forwarded localhost port elsewhere. The host
	// plumbing (wake + terminal view) lives in the headless host daemon, not here.
	const envPinned = Boolean(process.env.PROJECT_NAME);
	process.env.PROJECT_NAME = resolveSessionNaming(process.env.PROJECT_NAME, process.env.CLAUDE_CODE_SESSION_ID);
	// The one line that makes an identity split diagnosable: a session launched without the daemon's
	// env pin registers under a DERIVED name, and the phone thread keeps addressing the old one.
	console.error(
		`[bridge] identity ${process.env.PROJECT_NAME} (${envPinned ? "env-pinned" : "derived - manual launch?"})`,
	);
	if (!process.env.BRIDGE_ROUTER_URL) {
		process.env.BRIDGE_ROUTER_URL = inContainer ? "http://switchboard:20000" : "http://localhost:20000";
	}

	const agentType = process.env.AGENT_TYPE || detectAgentType();
	const isChannel = agentType === "claude";

	// Asked before the server exists, because it decides which tools get registered and what
	// guidance the session carries. Bounded and single-attempt: an unreachable gateway costs a beat
	// and falls back, never the startup.
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
	// After registerBridgeTools, so bridgeProjectName() already reflects whether PROJECT_NAME is set.
	// Gated on the owner having the plugin that renders these cards: a session picks up a plugin
	// toggle on its next start, which is why the console's own board calls it a restart-to-adopt.
	if (hasCapability(capabilities, "designer")) registerDesignerTools(mcpServer);
	// These tools reach a child process rather than a console surface, so the gate is whether one can
	// be reached at all: a daemon that declared the backend, or the CLI installed right here.
	for (const backend of AGENT_BACKENDS) registerAgentBackend(mcpServer, backend, capabilities);
	// Gated on the console plugin that renders the board: without it the owner has no way to see or
	// answer anything a session writes, so the tools would be a one-way channel into a surface nobody
	// is looking at.
	if (hasCapability(capabilities, "taskboard")) registerBoardTools(mcpServer);
	// Ref snapshotting is not a tool of its own: it rides the reply path, so it is switched on here
	// rather than registered. A session whose owner has no console able to render a code viewer never
	// pays to build one.
	setReferencesEnabled(hasCapability(capabilities, "references"));

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
	// See INITIAL_ROUTER_CONNECT_GRACE_MS: register on the bridge only once the client can actually
	// hear the pushes that registration triggers. A session with no initialized client should not be
	// present on the bridge at all - it would absorb pushes it can only drop.
	mcpServer.server.oninitialized = () => {
		setTimeout(connectToRouter, INITIAL_ROUTER_CONNECT_GRACE_MS);
	};
	await mcpServer.connect(transport);

	const mode = inContainer ? "crosstalk + connector" : "crosstalk + channel";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		// A locally hosted backend's child has no daemon supervising it, so this is the only thing that
		// ever reaps one. Left running, it would hold its model session open with nothing able to reach it.
		for (const local of localBackends) local.shutdown();
		process.exit(0);
	});
}
