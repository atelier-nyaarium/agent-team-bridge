import path from "node:path";
import { resolveLocalGatewayId } from "../shared/gateway-id.js";
import { MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { composeGateway, type GatewayConfig } from "./composeGateway.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { routerBootstrapOverride } from "./router/transport.js";
import type { WsData } from "./websocket.js";

export { createProjectPredicates } from "./composeGateway.js";

/** The process adapter: environment in, the composed graph behind Bun's listener, signals out. */
export async function startGateway(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	const DATA_DIR = process.env.DATA_DIR || "/app/data";
	const config: GatewayConfig = {
		dataDir: DATA_DIR,
		federationDir: process.env.FEDERATION_DIR || path.join(DATA_DIR, "federation"),
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

	const graph = composeGateway({
		config,
		allowFixtureIdentity: process.env.ALLOW_FIXTURE_IDENTITY === "1",
		openEnrollTls: ({ port, certPem, keyPem, fetch }) =>
			Bun.serve({ port, tls: { cert: certPem, key: keyPem }, fetch }),
	});

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

	const server = Bun.serve<WsData>({
		port: PORT,
		maxRequestBodySize: 8_000_000,
		fetch(req, server) {
			const url = new URL(req.url);

			const proxyMatch = url.pathname.match(/^\/connector\/([^/]+)\/ws$/);
			if (proxyMatch) {
				const project = proxyMatch[1];
				// Proxy only trusted catalog projects to prevent SSRF.
				if (!graph.offlineCatalog.has(project)) {
					return new Response("Unknown connector project", { status: 404 });
				}
				const authHeader = req.headers.get("Authorization") || "";
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "channel" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
							proxyProject: project,
							proxyAuth: authHeader,
						},
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/bridge") {
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "channel" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
						},
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			return graph.router(req);
		},
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
