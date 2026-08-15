import path from "node:path";
import { FileSecretStore } from "./federation-server/fileSecretStore.js";
import { RouterServer } from "./federation-server/routerServer.js";
import { loadRouterTls } from "./federation-server/routerTls.js";
import { installRejectionGuard } from "./shared/process-guards.js";

installRejectionGuard("federation-router");

const port = Number(process.env.PORT ?? 20001);
const dataDir = process.env.DATA_DIR ?? path.resolve("./data-federation");
const consoleToken = process.env.CONSOLE_BRIDGE_TOKEN;
const federationToken = process.env.FEDERATION_WS_TOKEN;

if (!consoleToken || !federationToken) {
	throw new Error("CONSOLE_BRIDGE_TOKEN and FEDERATION_WS_TOKEN are required");
}

const store = new FileSecretStore(dataDir);
const identity = await store.init();
const tls = loadRouterTls(dataDir);
const server = new RouterServer({ port, dataDir, consoleToken, federationToken, store, tls });
await server.start();
console.log(`[federation-router] identity ${identity.sign.pub}`);
console.log(`[federation-router] ready on port ${port}`);

function shutdown(): void {
	void server.stop().then(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
