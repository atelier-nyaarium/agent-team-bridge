import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { isInsideContainer } from "../shared/env.js";
import { parseSessionName } from "../shared/session-id.js";
import { closeRouter, connectToRouter } from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { capabilityInstructions, fetchCapabilities, hasCapability } from "./capabilities.js";
import { registerHumanTools } from "./channel/humanTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerDesignerTools } from "./designer/designerTools.js";
import { registerCompactSession } from "./devcontainer/compactSession.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSetEffortLevel } from "./devcontainer/setEffortLevel.js";
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

const CHANNEL_INSTRUCTIONS = [
	'Cross-team messages arrive as <channel source="..." ...> tags. ALL metadata rides as tag attributes (session_id, from, and reply_schema when the request specifies one); the tag body is the message itself, nothing is jammed into it.',
	"Read the request and do the work.",
	"Reply with the channel_reply tool: session_id (from the tag attributes), title (a one-line headline), summary (a few sentences), full (your prose reply, renders as markdown + mermaid), and fullSpoken (a spoken copy of full for text-to-speech) are all required - the console shows the title in its notification bar and speaks the spoken tiers aloud. Attachments (absolute file paths) are optional. The conversation stays open, so you may reply multiple times (interim updates, etc.) with no finality.",
	"When the inbound tag carries a reply_schema, reply with channel_reply_structured instead: pass session_id and a responseData object matching that schema.",
].join(" ");

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	// Every session is a bridge peer registering under a composite `spawn.session` name from
	// resolveSessionNaming (see team-name.ts for the composition rules). Peers reach the gateway on
	// the docker network inside a container or the forwarded localhost port elsewhere. The host
	// plumbing (wake + terminal view) lives in the headless host daemon, not here.
	process.env.PROJECT_NAME = resolveSessionNaming(process.env.PROJECT_NAME, process.env.CLAUDE_CODE_SESSION_ID);
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
	registerReloadPlugins(mcpServer);
	registerSetEffortLevel(mcpServer);
	registerCompactSession(mcpServer);
	registerHumanTools(mcpServer, capabilities);
	// After registerBridgeTools, so bridgeProjectName() already reflects whether PROJECT_NAME is set.
	// Gated on the owner having the plugin that renders these cards: a session picks up a plugin
	// toggle on its next start, which is why the console's own board calls it a restart-to-adopt.
	if (hasCapability(capabilities, "designer")) registerDesignerTools(mcpServer);
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
		process.exit(0);
	});
}
