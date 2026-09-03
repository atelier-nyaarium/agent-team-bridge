import { $ } from "bun";
import type WebSocket from "ws";
import { pinnedDial, realWebSocket } from "../src/gateway/router/pinnedSocket.js";
import { envGet, jparse, note } from "./lib/host.js";
import { ROUTER_PORT, readPublicReach, routerHealth } from "./lib/routerStart.js";
import { routerRunning } from "./lib/routerState.js";
import { createVerifyChecks, summarize } from "./lib/verifyChecks.js";
import { fetchRegisteredGateways, type RegisteredGateway } from "./setup-status.js";

////////////////////////////////
//  Constants
//
//  Health-probe the local federation Router and this Gateway's link to it: that the Router answers,
//  what it advertises, and that the Gateway is actually registered rather than merely running.

const GATEWAY_HEALTH = "http://127.0.0.1:20000/health";
// A dropped Gateway reconnects on a backoff that reaches a few seconds; 30s covers it with room.
const LINK_TRIES = 15;
const LINK_INTERVAL_MS = 2000;

////////////////////////////////
//  Functions & Helpers

/** Probe the Router and the Gateway, reporting each leg separately. Throws on the first leg that
 * fails, since a later one cannot be meaningful without it. */
export async function verify(): Promise<void> {
	if (!(await routerRunning())) throw new Error("the federation Router is not running - run ./start-federation.sh");

	// -k, not a pin: this probe runs on the host beside the Router, so there is no peer to
	// authenticate. It reports the fingerprint for the operator to compare against their devices.
	// Probes the BOUND address: a LAN bind unbinds loopback.
	const bind = await envGet("FEDERATION_BIND");
	if (!bind) throw new Error("no LAN bind in .env - run ./start-federation.sh");
	const router = await routerHealth(bind);
	if (!router) throw new Error(`the Router at ${bind}:${ROUTER_PORT} did not answer /health`);
	note(`Router healthy. TLS fingerprint ${router.certFingerprint}`);

	// The reach a console will steer by rides the app-token-gated `reach` op, not /health, so
	// asking for it here also proves the token in .env is the one the Router holds.
	const appToken = await envGet("CONSOLE_BRIDGE_TOKEN");
	if (!appToken) throw new Error("CONSOLE_BRIDGE_TOKEN missing from .env");
	const consoleUrl = `https://${bind}:${ROUTER_PORT}/console`;
	const bearer = `X-Console-Bridge-Token: Bearer ${appToken}`;
	const reachText =
		await $`curl -sk --max-time 5 -X POST ${consoleUrl} -H ${bearer} -H ${"Content-Type: application/json"} -d ${'{"reach":{}}'}`
			.quiet()
			.nothrow()
			.text();
	const reach = jparse<{ publicHost?: string | null; publicPort?: number; lanAddresses?: string[]; error?: string }>(
		reachText.trim(),
	);
	if (!reach || reach.error) {
		throw new Error(
			`the Router refused the reach op (${reach?.error ?? (reachText.trim().slice(0, 120) || "no answer")}) - is CONSOLE_BRIDGE_TOKEN in .env the one the Router runs with?`,
		);
	}
	const publicShown = reach.publicHost ? `${reach.publicHost}:${reach.publicPort ?? ROUTER_PORT}` : "(none)";
	const lanShown = reach.lanAddresses?.length ? reach.lanAddresses.join(", ") : "(none)";
	note(`Router advertises: public ${publicShown}, LAN ${lanShown}`);
	// The Router's advertised reach and .env should agree, since the same file fed both. They differ
	// only when the Router is running on an older .env, which a restart fixes.
	const env = await readPublicReach();
	if ((reach.publicHost ?? "") !== env.publicHost || (reach.publicPort ?? ROUTER_PORT) !== env.publicPort) {
		note("The running Router advertises an older public address than .env holds - restart ./start-federation.sh");
	}

	const gwText = await $`curl -s --max-time 5 ${GATEWAY_HEALTH}`.quiet().nothrow().text();
	const gateway = jparse<{ ok?: boolean }>(gwText.trim());
	if (!gateway?.ok) throw new Error("the Gateway did not answer /health - run ./start-gateway.sh");

	// The link is checked on BOTH sides, and given time. A Gateway reads `router_connected` off its
	// own socket, which stays OPEN across a half-open connection, so it can claim a link the Router
	// Both sides must report the link.
	// And a Router that was just (re)started drops the Gateway, which reconnects on a backoff of a
	// few seconds; a single read in that window reports an outage that is already healing.
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
	const gatewayReport = jparse<{
		ok?: boolean;
		version?: string;
		gatewayId?: string;
		incarnation?: number | null;
		protocolVersion?: number;
		opLedgerProtocol?: number;
	}>(gwText.trim());
	const routerUrl = `wss://${bind}:${ROUTER_PORT}`;
	const checks = createVerifyChecks({
		fetch,
		dial: dialConsole,
		env: process.env,
		router,
		gateway: gatewayReport ?? {},
		registered: link.registered,
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
			// Pinned adapter matches ws.
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

/** Poll until the Gateway says it is connected AND the Router holds a registration, or the wait
 * runs out. Returns the last thing each side said, so the caller reports which leg is missing. */
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
