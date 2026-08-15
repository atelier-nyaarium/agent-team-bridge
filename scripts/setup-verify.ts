import { $ } from "bun";
import { envGet, jparse, note } from "./lib/host.js";
import { routerRunning } from "./lib/routerState.js";

////////////////////////////////
//  Constants
//
//  Health-probe the local federation Router and this Gateway's link to it. Replaces the k8s
//  service-proxy probe: there is no cluster in the path any more, so what is worth checking is that
//  the Router answers, and that the Gateway is actually registered rather than merely running.

const ROUTER_PORT = 20001;
const GATEWAY_HEALTH = "http://127.0.0.1:20000/health";

////////////////////////////////
//  Functions & Helpers

/** Probe whatever compose actually bound. A LAN `FEDERATION_BIND` unbinds loopback, so a hardcoded
 * localhost probe reports a healthy Router as unreachable. `start-federation.sh` carries the bash
 * twin of this rule; keep the two in step. */
async function routerHealthUrl(): Promise<string> {
	const bind = await envGet("FEDERATION_BIND");
	const host = !bind || bind === "0.0.0.0" ? "127.0.0.1" : bind;
	return `https://${host}:${ROUTER_PORT}/health`;
}

/** Probe the Router and the Gateway, reporting each leg separately. Throws on the first leg that
 * fails, since a later one cannot be meaningful without it. */
export async function verify(): Promise<void> {
	if (!(await routerRunning())) throw new Error("the federation Router is not running - run ./start-federation.sh");

	// -k, not a pin: this probe runs on the host beside the Router, so there is no peer to
	// authenticate. It reports the fingerprint for the operator to compare against their devices.
	const healthUrl = await routerHealthUrl();
	const health = await $`curl -sk --max-time 5 ${healthUrl}`.quiet().nothrow().text();
	const router = jparse<{ ok?: boolean; certFingerprint?: string; gateways?: number }>(health.trim());
	if (!router?.ok)
		throw new Error(`the Router did not answer /health (got: ${health.trim().slice(0, 120) || "nothing"})`);
	note(`Router healthy. TLS fingerprint ${router.certFingerprint ?? "(absent)"}`);

	// The reach a console will steer by rides the app-token-gated `reach` op, not /health, so
	// asking for it here also proves the token in .env is the one the Router holds. Say plainly which
	// leg is missing: no public host strands a phone off the LAN, no LAN address strands one on it.
	const appToken = await envGet("CONSOLE_BRIDGE_TOKEN");
	if (!appToken) throw new Error("CONSOLE_BRIDGE_TOKEN missing from .env");
	const consoleUrl = healthUrl.replace(/\/health$/, "/console");
	const bearer = `X-Console-Bridge-Token: Bearer ${appToken}`;
	const reachText =
		await $`curl -sk --max-time 5 -X POST ${consoleUrl} -H ${bearer} -H ${"Content-Type: application/json"} -d ${'{"reach":{}}'}`
			.quiet()
			.nothrow()
			.text();
	const reach = jparse<{ publicHost?: string | null; lanAddresses?: string[]; error?: string }>(reachText.trim());
	if (!reach || reach.error) {
		throw new Error(
			`the Router refused the reach op (${reach?.error ?? (reachText.trim().slice(0, 120) || "no answer")}) - is CONSOLE_BRIDGE_TOKEN in .env the one the Router runs with?`,
		);
	}
	note(
		`Router advertises: public ${reach.publicHost ?? "(none - set FEDERATION_PUBLIC_HOST)"}, LAN ${reach.lanAddresses?.length ? reach.lanAddresses.join(", ") : "(none - set FEDERATION_BIND)"}`,
	);

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
	note(`Gateway healthy and registered. The Router holds ${router.gateways} gateway connection(s)`);
}
