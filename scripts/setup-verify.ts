import https from "node:https";
import { $ } from "bun";
import type WebSocket from "ws";
import { pinnedDial, realWebSocket } from "../src/gateway/router/pinnedSocket.js";
import { envGet, jparse, note } from "./lib/host.js";
import { ROUTER_PORT, readPublicReach, routerHealth } from "./lib/routerStart.js";
import { routerRunning } from "./lib/routerState.js";
import { createVerifyChecks, summarize } from "./lib/verifyChecks.js";
import { fetchRegisteredGateways, type RegisteredGateway } from "./setup-status.js";

// Local Router checks.

const GATEWAY_HEALTH = "http://127.0.0.1:20000/health";
// Allow reconnect backoff.
const LINK_TRIES = 15;
const LINK_INTERVAL_MS = 2000;

// Check helpers.

/** Probe Router links. */
export async function verify(): Promise<void> {
	const localRouter = await routerRunning();
	let bind = "";
	let router;
	if (localRouter) {
		// Local probe skips pinning.
		bind = await envGet("FEDERATION_BIND");
		if (!bind) throw new Error("no LAN bind in .env - run ./start-federation.sh");
		router = await routerHealth(bind);
		if (!router) throw new Error(`the Router at ${bind}:${ROUTER_PORT} did not answer /health`);
		note(`Router healthy. TLS fingerprint ${router.certFingerprint}`);
	} else {
		const host = (await envGet("FEDERATION_ROUTER_HOST"))?.trim();
		const port = Number(await envGet("FEDERATION_ROUTER_PORT")) || ROUTER_PORT;
		const persisted = (await envGet("FEDERATION_ROUTER_CERT_FP"))?.trim().toLowerCase();
		if (!host) throw new Error("FEDERATION_ROUTER_HOST missing from .env");
		if (!persisted) throw new Error("FEDERATION_ROUTER_CERT_FP missing from .env");
		const routerUrl = `https://${host}:${port}`;
		router = await pinnedRouterHealth(routerUrl, persisted);
		if (!router) throw new Error(`the Router at ${routerUrl} did not answer pinned /health`);
		note(`Remote Router healthy. TLS fingerprint ${router.certFingerprint}`);
	}

	if (localRouter) {
		// Verify advertised reach.
		const appToken = await envGet("CONSOLE_BRIDGE_TOKEN");
		if (!appToken) throw new Error("CONSOLE_BRIDGE_TOKEN missing from .env");
		const consoleUrl = `https://${bind}:${ROUTER_PORT}/console`;
		const bearer = `X-Console-Bridge-Token: Bearer ${appToken}`;
		const reachText =
			await $`curl -sk --max-time 5 -X POST ${consoleUrl} -H ${bearer} -H ${"Content-Type: application/json"} -d ${'{"reach":{}}'}`
				.quiet()
				.nothrow()
				.text();
		const reach = jparse<{
			publicHost?: string | null;
			publicPort?: number;
			lanAddresses?: string[];
			error?: string;
		}>(reachText.trim());
		if (!reach || reach.error) {
			throw new Error(
				`the Router refused the reach op (${reach?.error ?? (reachText.trim().slice(0, 120) || "no answer")}) - is CONSOLE_BRIDGE_TOKEN in .env the one the Router runs with?`,
			);
		}
		const publicShown = reach.publicHost ? `${reach.publicHost}:${reach.publicPort ?? ROUTER_PORT}` : "(none)";
		const lanShown = reach.lanAddresses?.length ? reach.lanAddresses.join(", ") : "(none)";
		note(`Router advertises: public ${publicShown}, LAN ${lanShown}`);
		// Compare reach with .env.
		const env = await readPublicReach();
		if ((reach.publicHost ?? "") !== env.publicHost || (reach.publicPort ?? ROUTER_PORT) !== env.publicPort) {
			note(
				"The running Router advertises an older public address than .env holds - restart ./start-federation.sh",
			);
		}
	}

	const gwText = await $`curl -s --max-time 5 ${GATEWAY_HEALTH}`.quiet().nothrow().text();
	const gateway = jparse<{ ok?: boolean }>(gwText.trim());
	if (!gateway?.ok) throw new Error("the Gateway did not answer /health - run ./start-gateway.sh");

	const gatewayReport = jparse<{
		ok?: boolean;
		version?: string;
		gatewayId?: string;
		incarnation?: number | null;
		protocolVersion?: number;
		opLedgerProtocol?: number;
		router_connected?: boolean;
	}>(gwText.trim());
	let registered: Array<{ gatewayId: string; incarnation?: number; protocolVersion?: number }> = [];
	if (localRouter) {
		// Verify both link views.
		// Allow reconnect backoff.
		const link = await awaitGatewayLink(bind);
		if (link.registered.length === 0) note("Gateways: none registered");
		else for (const g of link.registered) note(`Gateway ${g.gatewayId}: ${g.signFp ?? "(no identity presented)"}`);
		if (!link.connected) {
			throw new Error("the Gateway is up but NOT connected to the Router - check its transport.json and its log");
		}
		if (!link.held) {
			throw new Error(
				"the Gateway believes it is connected but the Router holds NO registration - restart the Gateway",
			);
		}
		registered = link.registered;
	} else if (gatewayReport?.gatewayId) {
		registered = [
			{
				gatewayId: gatewayReport.gatewayId,
				incarnation: gatewayReport.incarnation ?? undefined,
				protocolVersion: gatewayReport.protocolVersion,
			},
		];
		if (!gatewayReport.router_connected) {
			throw new Error("the Gateway is up but NOT connected to the Router - check its transport.json and its log");
		}
	}
	const routerHost = localRouter ? bind : (await envGet("FEDERATION_ROUTER_HOST"))?.trim();
	const routerPort = localRouter ? ROUTER_PORT : Number(await envGet("FEDERATION_ROUTER_PORT")) || ROUTER_PORT;
	const routerUrl = `wss://${routerHost}:${routerPort}`;
	const checks = createVerifyChecks({
		fetch,
		dial: dialConsole,
		env: process.env,
		router,
		gateway: gatewayReport ?? {},
		registered,
		localGatewayId: gatewayReport?.gatewayId ?? "",
		routerUrl,
		gatewayUrl: "http://127.0.0.1:20000",
	});
	const results = [];
	for (const check of checks) {
		const answer = await check.run();
		results.push(answer);
		if (answer.ok) console.log(`PASS ${check.name}`);
		else {
			console.log(`FAIL ${check.name}: ${answer.detail}`);
		}
	}
	const summary = summarize(results);
	if (summary.summary) {
		console.log(summary.summary);
		process.exitCode = 1;
	} else note(`Gateway healthy and registered.`);
}

async function pinnedRouterHealth(
	url: string,
	expectedFingerprint: string,
): Promise<Awaited<ReturnType<typeof routerHealth>>> {
	const parsed = new URL(`${url}/health`);
	const pin = pinnedDial(parsed.hostname, Number(parsed.port) || ROUTER_PORT, expectedFingerprint);
	const text = await new Promise<string>((resolve, reject) => {
		const request = https.get(
			parsed,
			{
				rejectUnauthorized: false,
				createConnection: pin.createConnection as never,
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => resolve(body));
			},
		);
		request.setTimeout(10_000, () => request.destroy(new Error("timeout")));
		request.once("error", reject);
	});
	if (pin.verdict() !== "match") throw new Error("Router certificate was not pinned");
	const health = jparse<{
		ok?: boolean;
		certFingerprint?: string;
		gateways?: number;
		version?: string;
		protocolVersion?: number;
	}>(text.trim());
	if (!health?.ok || !health.certFingerprint) return null;
	return {
		certFingerprint: health.certFingerprint,
		gateways: health.gateways ?? 0,
		version: health.version,
		protocolVersion: health.protocolVersion,
	};
}

async function dialConsole(url: string, expectedFingerprint: string): Promise<void> {
	if (!url.startsWith("wss://")) throw new Error("refusing non-TLS Router URL");
	const parsed = new URL(url);
	const pin = pinnedDial(parsed.hostname, Number(parsed.port) || ROUTER_PORT, expectedFingerprint);
	const WebSocket = realWebSocket();
	await new Promise<void>((resolve, reject) => {
		let ws: WebSocket | null = null;
		const timeout = setTimeout(() => {
			ws?.close();
			reject(new Error("timeout"));
		}, 10_000);
		ws = new WebSocket(url, {
			// Match the WebSocket adapter.
			createConnection: pin.createConnection as WebSocket.ClientOptions["createConnection"],
			headers: { "X-Console-Bridge-Token": `Bearer ${process.env.CONSOLE_BRIDGE_TOKEN ?? ""}` },
		});
		ws.once("open", () => {
			clearTimeout(timeout);
			if (pin.verdict() !== "match") {
				ws.close();
				reject(new Error("Router certificate was not pinned"));
				return;
			}
			ws.close();
			resolve();
		});
		ws.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

/** Poll Gateway links. */
async function awaitGatewayLink(
	bind: string,
): Promise<{ connected: boolean; held: boolean; registered: RegisteredGateway[] }> {
	let connected = false;
	let held = false;
	let registered: RegisteredGateway[] = [];
	for (let i = 0; i < LINK_TRIES; i++) {
		const [gwText, list, router] = await Promise.all([
			$`curl -s --max-time 5 ${GATEWAY_HEALTH}`.quiet().nothrow().text(),
			fetchRegisteredGateways(bind),
			routerHealth(bind),
		]);
		if (list === null) throw new Error("the Router refused the gateways op");
		connected = jparse<{ router_connected?: boolean }>(gwText.trim())?.router_connected ?? false;
		held = (router?.gateways ?? 0) > 0;
		registered = list;
		if (connected && held) break;
		if (i === 0) note("Waiting for the Gateway to register with the Router");
		await Bun.sleep(LINK_INTERVAL_MS);
	}
	return { connected, held, registered };
}
