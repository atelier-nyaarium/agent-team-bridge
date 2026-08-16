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

// The reach the Router advertises on /health. Both optional: an unset public host means the owner
// has no port-forward yet, and an unset LAN list means a loopback-only bind, which no phone reaches
// anyway. Loopback and 0.0.0.0 are never a reach a client could use, so they are dropped here
// rather than advertised.
const publicHost = (process.env.FEDERATION_PUBLIC_HOST ?? "").trim() || null;
const lanAddresses = (process.env.FEDERATION_LAN_ADDRESSES ?? "")
	.split(",")
	.map((a) => a.trim())
	.filter((a) => a && a !== "127.0.0.1" && a !== "0.0.0.0" && a !== "localhost");

const store = new FileSecretStore(dataDir);
const identity = await store.init();
const tls = loadRouterTls(dataDir);
const server = new RouterServer({
	port,
	dataDir,
	consoleToken,
	federationToken,
	store,
	tls,
	reach: { publicHost, lanAddresses },
});
if (publicHost) console.log(`[federation-router] public host ${publicHost}`);
if (lanAddresses.length) console.log(`[federation-router] lan addresses ${lanAddresses.join(", ")}`);
await server.start();
console.log(`[federation-router] identity ${identity.sign.pub}`);
console.log(`[federation-router] ready on port ${port}`);

function shutdown(): void {
	server.stop().then(
		() => process.exit(0),
		(err) => {
			console.error(`[federation-router] shutdown failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
