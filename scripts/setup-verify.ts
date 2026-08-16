import { $ } from "bun";
import { envGet, jparse, note } from "./lib/host.js";
import { ROUTER_PORT, readPublicReach, routerHealth } from "./lib/routerStart.js";
import { routerRunning } from "./lib/routerState.js";
import { fetchRegisteredGateways } from "./setup-status.js";

////////////////////////////////
//  Constants
//
//  Health-probe the local federation Router and this Gateway's link to it: that the Router answers,
//  what it advertises, and that the Gateway is actually registered rather than merely running.

const GATEWAY_HEALTH = "http://127.0.0.1:20000/health";

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

	const registered = await fetchRegisteredGateways(bind);
	if (registered === null) throw new Error("the Router refused the gateways op");
	if (registered.length === 0) note("Gateways: none registered");
	else for (const g of registered) note(`Gateway ${g.gatewayId}: ${g.signFp ?? "(no identity presented)"}`);

	const gwText = await $`curl -s --max-time 5 ${GATEWAY_HEALTH}`.quiet().nothrow().text();
	const gateway = jparse<{ ok?: boolean; router_connected?: boolean }>(gwText.trim());
	if (!gateway?.ok) throw new Error("the Gateway did not answer /health - run ./start-gateway.sh");
	if (!gateway.router_connected) {
		throw new Error("the Gateway is up but NOT connected to the Router - check its transport.json and its log");
	}
	// Both sides, not one. A Gateway reads `router_connected` off its own socket, which stays OPEN
	// across a half-open connection, so it can claim a link the Router is not holding - and every
	// console op relayed over that link fails while both ends look healthy.
	if (!router.gateways) {
		throw new Error(
			"the Gateway believes it is connected but the Router holds NO registration - restart the Gateway",
		);
	}
	note(`Gateway healthy and registered.`);
}
