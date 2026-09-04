import path from "node:path";
import { FileSecretStore } from "./federation-server/fileSecretStore.js";
import { decideServe } from "./federation-server/migration/serveGate.js";
import { RouterServer } from "./federation-server/routerServer.js";
import { loadRouterTls } from "./federation-server/routerTls.js";
import { refuseFixtureIdentity } from "./shared/fixture-identity.js";
import { installRejectionGuard } from "./shared/process-guards.js";

installRejectionGuard("federation-router");

const port = Number(process.env.PORT ?? 20001);
const dataDir = process.env.DATA_DIR ?? path.resolve("./data-federation");
const consoleToken = process.env.CONSOLE_BRIDGE_TOKEN;
const federationToken = process.env.FEDERATION_WS_TOKEN;

if (!consoleToken || !federationToken) {
	throw new Error("CONSOLE_BRIDGE_TOKEN and FEDERATION_WS_TOKEN are required");
}

// Advertised client reaches.
const publicHost = (process.env.FEDERATION_PUBLIC_HOST ?? "").trim() || null;
const publicPortRaw = Number((process.env.FEDERATION_PUBLIC_PORT ?? "").trim());
const publicPort =
	publicHost && Number.isInteger(publicPortRaw) && publicPortRaw > 0 && publicPortRaw !== port
		? publicPortRaw
		: undefined;
const lanAddresses = (process.env.FEDERATION_LAN_ADDRESSES ?? "")
	.split(",")
	.map((a) => a.trim())
	.filter((a) => a && a !== "127.0.0.1" && a !== "0.0.0.0" && a !== "localhost");

// Refuse unverified imports.
const serve = decideServe(dataDir);
if (serve.kind === "refuse") {
	console.error(`[router] refusing to serve: ${serve.reason}. Re-run the import and let it verify.`);
	process.exit(1);
}

const store = new FileSecretStore(dataDir);
const identity = await store.init();
refuseFixtureIdentity(identity.sign.pub, "Router");
const tls = loadRouterTls(dataDir);
const server = new RouterServer({
	port,
	dataDir,
	consoleToken,
	federationToken,
	store,
	tls,
	reach: publicPort ? { publicHost, publicPort, lanAddresses } : { publicHost, lanAddresses },
});
if (publicHost) console.log(`[federation-router] public host ${publicHost}:${publicPort ?? port}`);
if (lanAddresses.length) console.log(`[federation-router] lan addresses ${lanAddresses.join(", ")}`);
await server.start();
console.log(`[federation-router] identity ${identity.sign.pub}`);
console.log(`[federation-router] ready on port ${server.listeningPort ?? port}`);

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
