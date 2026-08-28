import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getAuthToken,
	getListenerState,
	restartWithoutTls,
	restartWithTls,
	setAuthToken,
	startListener,
	stopListener,
} from "./listener.js";
import { getAllClients, getClient } from "./sessions.js";
import { generateCaCert, generateServerCert } from "./tls.js";
import { textResult } from "./utils.js";

const SCHEMA_TEMPLATE = `/**
 * MCP Schema - Switchboard Connector
 *
 * Each tool defined here becomes available to IDE agents when a game client
 * connects via WebSocket. The agent calls the tool, the connector forwards it
 * to the game client, and the client returns a result.
 *
 * @param {import("zod").ZodType} z - Zod module for parameter validation.
 * @returns {Array} Array of tool definitions.
 */
export default function (z) {
\treturn [
\t\t{
\t\t\tname: "foo",
\t\t\ttitle: "Foo",
\t\t\tdescription: \`Test connector calls by echoing a number.\`,
\t\t\tschema: z.object({
\t\t\t\tbar: z.number().describe(\`Numeric value.\`),
\t\t\t}),
\t\t},
\t];
}
`;

////////////////////////////////
//  Functions & Helpers

export function registerConnectorTools(
	mcpServer: McpServer,
	projectName: string,
	connectorDir: string,
	port: number,
): void {
	const schemaPath = `${connectorDir}/mcp-schema.js`;
	const hasSchema = existsSync(schemaPath);
	const hasCerts = existsSync(`${connectorDir}/server.crt`) && existsSync(`${connectorDir}/server.key`);

	mcpServer.registerTool(
		"mcpConnectorStatus",
		{
			title: "MCP Connector Status",
			description: `Show connector status and connected clients.`,
			inputSchema: {},
		},
		async () => {
			const listenerState = getListenerState();
			const serving = !!listenerState;
			const clients = getAllClients().map((c) => ({
				clientId: c.shortHash,
				...(c.instance && { instance: c.instance }),
				connectedAt: c.connectedAt.toISOString(),
				remoteAddress: c.remoteAddress,
			}));

			const result: Record<string, unknown> = serving
				? {
						serving,
						mode: listenerState.mode,
						hostname: listenerState.hostname,
						port: listenerState.port,
						authEnabled: !!getAuthToken(),
						clients,
					}
				: { serving, port, authEnabled: !!getAuthToken() };

			if (!serving) {
				result.hint = hasSchema
					? `This session is not serving. Port ${port} is likely held by another IDE session. Call mcpConnectorUnserve in that session to release it, then mcpConnectorServe here.`
					: `This session is not serving. Call mcpConnectorServe to start, then mcpConnectorCreateSchema to create a schema.`;
			} else if (!hasSchema) {
				result.hint = `No mcp-schema.js found. Call mcpConnectorCreateSchema to initialize, then /mcp to restart.`;
			} else if (clients.length === 0) {
				result.hint = `Serving but no game clients connected yet.`;
			} else {
				result.hint = `Ready. Use project tools with a clientId or instance name from the clients list.`;
			}

			if (!getAuthToken() || !hasCerts) {
				const steps = [];
				if (!getAuthToken()) steps.push("mcpConnectorGenerateToken");
				if (!hasCerts) steps.push("mcpConnectorGenerateCert");
				steps.push("mcpConnectorOpen");
				result.security = `For remote access: ${steps.join(" → ")}`;
			}

			return textResult(JSON.stringify(result, null, 2));
		},
	);

	mcpServer.registerTool(
		"mcpConnectorServe",
		{
			title: "Start Connector",
			description: `Serve project tools on the connector port.`,
			inputSchema: {},
		},
		async () => {
			if (getListenerState()) {
				return textResult(`Already serving on port ${port}.`);
			}
			try {
				startListener(port);
				return textResult(`Now serving on port ${port}. Game clients can connect.`);
			} catch {
				return textResult(
					`Port ${port} is held by another IDE session. Call mcpConnectorUnserve in that session first.`,
					true,
				);
			}
		},
	);

	mcpServer.registerTool(
		"mcpConnectorUnserve",
		{
			title: "Stop Connector",
			description: `Stop serving project tools. Disconnect clients.`,
			inputSchema: {},
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Nothing to stop.`);
			}
			stopListener();
			return textResult(
				`Stopped serving on port ${port}. Game clients disconnected. Another IDE session can now call mcpConnectorServe.`,
			);
		},
	);

	mcpServer.registerTool(
		"mcpConnectorOpen",
		{
			title: "Open MCP Connector",
			description: `
# Open MCP Connector

Open the connector publicly with \`HTTPS/WSS\`.

## Required

- \`mcpConnectorGenerateToken\`
- \`mcpConnectorGenerateCert\`

## Effect

Disconnects connected clients.
`.trim(),
			inputSchema: {},
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			try {
				if (!getAuthToken()) {
					return textResult(
						`Cannot open to public without authentication. Run mcpConnectorGenerateToken first.`,
						true,
					);
				}
				restartWithTls(connectorDir, port);
				const state = getListenerState();
				return textResult(
					JSON.stringify(
						{
							status: "open",
							mode: state?.mode,
							hostname: state?.hostname,
							port: state?.port,
							warning: `All previously connected clients were disconnected. They must reconnect using wss://.`,
						},
						null,
						2,
					),
				);
			} catch (error) {
				return textResult((error as Error).message, true);
			}
		},
	);

	mcpServer.registerTool(
		"mcpConnectorClose",
		{
			title: "Close MCP Connector",
			description: `Restore localhost-only HTTP. Disconnect remote clients.`,
			inputSchema: {},
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			restartWithoutTls(port);
			const state = getListenerState();
			return textResult(
				JSON.stringify(
					{
						status: "closed",
						mode: state?.mode,
						hostname: state?.hostname,
						port: state?.port,
					},
					null,
					2,
				),
			);
		},
	);

	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const generateCertObj: any = z.object({
		domain: z.string().optional().describe(`Certificate SAN domain. Defaults to \`localhost\`.`),
	});
	mcpServer.registerTool(
		"mcpConnectorGenerateCert",
		{
			title: "Generate TLS Certificate",
			description: `Generate self-signed certificates in \`.claude/connector/\` for \`mcpConnectorOpen\`.`,
			inputSchema: generateCertObj,
		},
		async ({ domain: domainArg }: { domain?: string }) => {
			try {
				const domain = domainArg || "localhost";

				if (!existsSync(connectorDir)) {
					mkdirSync(connectorDir, { recursive: true });
				}

				const ca = generateCaCert(projectName);
				const server = generateServerCert({ caCert: ca.caCert, caKey: ca.caKey, domain });

				writeFileSync(`${connectorDir}/ca.crt`, ca.caCert);
				writeFileSync(`${connectorDir}/ca.key`, ca.caKey, { mode: 0o600 });
				writeFileSync(`${connectorDir}/server.crt`, server.serverCert);
				writeFileSync(`${connectorDir}/server.key`, server.serverKey, { mode: 0o600 });

				return textResult(
					JSON.stringify(
						{
							status: "generated",
							domain,
							files: ["ca.crt", "ca.key", "server.crt", "server.key"],
							connectorDir,
							next: `Run mcpConnectorOpen to enable HTTPS/WSS.`,
						},
						null,
						2,
					),
				);
			} catch (error) {
				return textResult((error as Error).message, true);
			}
		},
	);

	mcpServer.registerTool(
		"mcpConnectorGenerateToken",
		{
			title: "Generate Auth Token",
			description: `Generate and persist a bearer token for \`mcpConnectorOpen\`.`,
			inputSchema: {},
		},
		async () => {
			const token = randomUUID();

			if (!existsSync(connectorDir)) {
				mkdirSync(connectorDir, { recursive: true });
			}
			writeFileSync(`${connectorDir}/token`, token, { mode: 0o600 });
			setAuthToken(token);

			return textResult(
				JSON.stringify(
					{
						status: "generated",
						token,
						next: `Use mcpConnectorClientBundle to generate a connection bundle for testers.`,
					},
					null,
					2,
				),
			);
		},
	);

	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const disconnectObj: any = z.object({
		clientId: z.string().describe(`Six-character client hash from \`mcpConnectorStatus\`.`),
	});
	mcpServer.registerTool(
		"mcpConnectorDisconnect",
		{
			title: "Disconnect Game Client",
			description: `Disconnect \`clientId\` and end pending tool invocations.`,
			inputSchema: disconnectObj,
		},
		async ({ clientId }: { clientId: string }) => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			const client = getClient(clientId);
			if (!client) {
				return textResult(`Client ${clientId} not found.`, true);
			}
			client.ws.close(1000, "Kicked by agent");
			return textResult(`Disconnected client ${clientId}.`);
		},
	);

	mcpServer.registerTool(
		"mcpConnectorClientBundle",
		{
			title: "Get Client Connection Bundle",
			description: `Generate \`connect.json\` and \`ca.crt\` for a game's \`mcp-connector/\` folder.`,
			inputSchema: {},
		},
		async () => {
			const listenerState = getListenerState();
			if (!listenerState) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}

			const protocol = listenerState.mode === "https" ? "wss" : "ws";
			const host = listenerState.hostname === "0.0.0.0" ? "YOUR_HOST_IP" : listenerState.hostname;
			const token = getAuthToken();
			const connectObj: Record<string, string> = { url: `${protocol}://${host}:${listenerState.port}/ws` };
			if (token) {
				connectObj.token = token;
			}
			const connectJson = JSON.stringify(connectObj, null, 2);

			let caCertContent: string | null = null;
			const caCertPath = `${connectorDir}/ca.crt`;
			if (existsSync(caCertPath)) {
				caCertContent = readFileSync(caCertPath, "utf-8");
			}

			const parts = [
				`## connect.json\n\nPlace in your game's mcp-connector/ folder:\n\n\`\`\`json\n${connectJson}\n\`\`\``,
			];

			if (caCertContent) {
				parts.push(
					`\n## ca.crt\n\nPlace alongside connect.json (required for self-signed certs):\n\n\`\`\`\n${caCertContent}\`\`\``,
				);
			}

			return textResult(parts.join("\n"));
		},
	);

	if (!hasSchema) {
		mcpServer.registerTool(
			"mcpConnectorCreateSchema",
			{
				title: "Create MCP Schema",
				description: `Create an example \`.claude/connector/mcp-schema.js\` tool schema.`,
				inputSchema: {},
			},
			async () => {
				if (!existsSync(connectorDir)) {
					mkdirSync(connectorDir, { recursive: true });
				}
				writeFileSync(schemaPath, SCHEMA_TEMPLATE);

				const gitignorePath = `${connectorDir}/.gitignore`;
				if (!existsSync(gitignorePath)) {
					writeFileSync(gitignorePath, "*.crt\n*.key\ntoken\n");
				}

				return textResult(
					`Created ${schemaPath} with example schema.\nUse /mcp to restart this MCP server to load it.`,
				);
			},
		);
	}
}
