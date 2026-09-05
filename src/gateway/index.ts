import path from "node:path";
import type { Server } from "bun";
import { resolveLocalGatewayId } from "../shared/gateway-id.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { composeGateway, type GatewayConfig, type GatewayGraph } from "./composeGateway.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { routerBootstrapOverride } from "./router/transport.js";
import type { WsData } from "./websocket.js";

export { createProjectPredicates } from "./composeGateway.js";

const CONNECTOR_PATH = /^\/connector\/([^/]+)\/ws$/;

function configFromEnv(): GatewayConfig {
	const dataDir = process.env.DATA_DIR || "/app/data";
	return {
		dataDir,
		federationDir: process.env.FEDERATION_DIR || path.join(dataDir, "federation"),
		logDir: path.join("/app", "log"),
		gatewayId: resolveLocalGatewayId(),
		maxBlobStoreBytes: parseInt(process.env.MAX_BLOB_STORE_BYTES || String(MAX_BLOB_BYTES * 16), 10),
		wakeTimeoutMs: parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10),
		enrollTlsPort: parseInt(process.env.ENROLL_TLS_PORT || "20003", 10),
		enrollLanHost: process.env.ENROLL_LAN_HOST || "0.0.0.0",
		enrollNonce: process.env.ENROLL_NONCE,
		hostWsToken: process.env.HOST_WS_TOKEN,
		routerBootstrapUrl: routerBootstrapOverride(
			process.env.FEDERATION_ROUTER_HOST,
			process.env.FEDERATION_ROUTER_PORT,
		),
	};
}

function socketData(extra: Partial<WsData> = {}): WsData {
	return {
		teamName: null,
		subId: "",
		conversationId: null,
		mode: "channel" as const,
		missedPings: 0,
		isStale: false,
		handshakeConfirmed: false,
		...extra,
	};
}

/** A socket path answers with a Response only when the upgrade is refused. */
function serve(req: Request, server: Server<WsData>, graph: GatewayGraph): Response | Promise<Response> | undefined {
	const url = new URL(req.url);
	const connector = url.pathname.match(CONNECTOR_PATH);
	if (connector) {
		const project = connector[1] as string;
		// Proxy only trusted catalog projects to prevent SSRF.
		if (!graph.wsHandlers.isConnectorProject(project)) {
			return new Response("Unknown connector project", { status: 404 });
		}
		const data = socketData({ proxyProject: project, proxyAuth: req.headers.get("Authorization") || "" });
		return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
	}
	if (url.pathname === "/bridge") {
		return server.upgrade(req, { data: socketData() })
			? undefined
			: new Response("WebSocket upgrade failed", { status: 400 });
	}
	return graph.router(req);
}

function installSignalHandlers(graph: GatewayGraph): void {
	const shutdown = () => {
		graph.close().then(
			() => process.exit(0),
			(err) => {
				console.error(`[gateway] shutdown persist failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			},
		);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.on("uncaughtException", (err) => {
		console.error("[gateway] uncaughtException:", err);
		// Crash exits without flushing inconsistent state.
		process.exit(1);
	});
}

/** The process adapter: environment in, the composed graph behind Bun's listener, signals out. */
export async function startGateway(): Promise<void> {
	const port = parseInt(process.env.PORT || "20000", 10);
	const graph = composeGateway({
		config: configFromEnv(),
		allowFixtureIdentity: process.env.ALLOW_FIXTURE_IDENTITY === "1",
		openEnrollTls: ({ port: tlsPort, certPem, keyPem, fetch }) =>
			Bun.serve({ port: tlsPort, tls: { cert: certPem, key: keyPem }, fetch }),
	});
	installSignalHandlers(graph);

	const server = Bun.serve<WsData>({
		port,
		maxRequestBodySize: 8_000_000,
		fetch: (req, bunServer) => serve(req, bunServer, graph),
		websocket: {
			open(ws) {
				if (ws.data.proxyProject) {
					setupProxy(ws, ws.data.proxyProject, ws.data.proxyAuth || "");
					return;
				}
				graph.wsHandlers.open(ws);
			},
			message(ws, raw) {
				if (isProxyConnection(ws)) {
					handleProxyMessage(ws, raw);
					return;
				}
				graph.wsHandlers.message(ws, raw);
			},
			close(ws) {
				if (isProxyConnection(ws)) {
					handleProxyClose(ws);
					return;
				}
				graph.wsHandlers.close(ws);
			},
			pong(ws) {
				graph.wsHandlers.pong(ws);
			},
		},
	});

	console.log(`[router] listening on :${server.port} (HTTP + WebSocket)`);
}
