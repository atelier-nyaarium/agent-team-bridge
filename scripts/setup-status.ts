// What the setup menu shows above the dial: the state every option's label and every next step
// depend on, read BEFORE the menu draws so the screen that orients the owner is not the one screen
// that knows nothing. Nothing here mutates.

import { $ } from "bun";
import { sanitizeGatewayId } from "../src/shared/gateway-id.js";
import { readAdminDomain } from "./bootstrap-domain.js";
import { dockerBlockerTitle } from "./lib/docker-probe.js";
import { detectLanHosts, envGet, jparse } from "./lib/host.js";
import { ROUTER_PORT, readPublicReach, routerHealth, shortFp } from "./lib/routerStart.js";
import { readRouterFed, routerRunning } from "./lib/routerState.js";
import { gatewayHostname, transportInstalled } from "./setup-gateway.js";

////////////////////////////////
//  Interfaces & Types

export interface RegisteredGateway {
	gatewayId: string;
	signFp: string | null;
}

export interface SetupStatus {
	/** Every IPv4 this machine holds, route-out first, and the one the Router is bound to. The bound
	 * address drops out of the list after a DHCP move, until the next start. */
	lanHosts: string[];
	lanBound: string;
	publicHost: string;
	publicPort: number;
	routerRunning: boolean;
	/** What is stopping docker from working here, or empty when nothing is. Every option ends in
	 * `compose up`, so this outranks every other row: none of them can change while it is set. */
	dockerBlocker: string;
	/** The Router this machine dials when it does not run one, as `host:port`. Empty on a machine
	 * that hosts its own. */
	remoteRouter: string;
	certFingerprint: string | null;
	domain: "none" | "pending" | "rooted";
	gatewayId: string;
	gatewayEnrolled: boolean;
	/** Registrations the Router holds for the admin Domain; null when it could not be asked. */
	gateways: RegisteredGateway[] | null;
}

////////////////////////////////
//  Functions & Helpers

/** Ask the Router which gateways are registered into the admin Domain. Rides the app-token-gated
 * `gateways` op, so a wrong token in .env reads as null here rather than as an empty list. */
export async function fetchRegisteredGateways(lan: string): Promise<RegisteredGateway[] | null> {
	const appToken = await envGet("CONSOLE_BRIDGE_TOKEN");
	if (!appToken) return null;
	const url = `https://${lan}:${ROUTER_PORT}/console`;
	const bearer = `X-Console-Bridge-Token: Bearer ${appToken}`;
	const text =
		await $`curl -sk --max-time 5 -X POST ${url} -H ${bearer} -H ${"Content-Type: application/json"} -d ${'{"gateways":{}}'}`
			.quiet()
			.nothrow()
			.text();
	const parsed = jparse<{ gateways?: RegisteredGateway[] }>(text.trim());
	return parsed?.gateways ?? null;
}

export async function readSetupStatus(): Promise<SetupStatus> {
	const [
		lanHosts,
		lanBound,
		reach,
		running,
		domainId,
		gatewayId,
		gatewayEnrolled,
		remoteHost,
		remotePort,
		dockerBlocker,
	] = await Promise.all([
		detectLanHosts(),
		envGet("FEDERATION_BIND"),
		readPublicReach(),
		routerRunning(),
		envGet("FEDERATION_DOMAIN_ID"),
		// Sanitized the way the gateway sanitizes its own id at register, or `Sakura` in .env never
		// matches the `sakura` the Router holds and this machine reads as never registered.
		envGet("GATEWAY_ID").then((id) => sanitizeGatewayId(id || gatewayHostname())),
		transportInstalled(),
		envGet("FEDERATION_ROUTER_HOST"),
		envGet("FEDERATION_ROUTER_PORT"),
		dockerBlockerTitle(),
	]);
	// A machine that only runs a gateway has no local Router, and reading its rows as "not running,
	// Domain none" says nothing is set up when in fact everything is - it just lives elsewhere. So the
	// Router row names the REMOTE one this gateway was pointed at.
	const remoteRouter = !running && remoteHost && remoteHost !== "federation-router" ? remoteHost : "";

	let certFingerprint: string | null = null;
	let gateways: RegisteredGateway[] | null = null;
	let domain: SetupStatus["domain"] = "none";
	if (running) {
		const probeHost = lanBound || lanHosts[0];
		const [health, fed, registered] = await Promise.all([
			routerHealth(probeHost),
			readRouterFed(),
			fetchRegisteredGateways(probeHost),
		]);
		certFingerprint = health?.certFingerprint ?? null;
		gateways = registered;
		if (fed && domainId) {
			const admin = readAdminDomain(fed, domainId);
			domain = admin.rooted ? "rooted" : admin.displayName ? "pending" : "none";
		}
	}

	return {
		lanHosts,
		lanBound,
		publicHost: reach.publicHost,
		publicPort: reach.publicPort,
		routerRunning: running,
		dockerBlocker: dockerBlocker ?? "",
		remoteRouter: remoteRouter ? `${remoteRouter}:${Number(remotePort) || ROUTER_PORT}` : "",
		certFingerprint,
		domain,
		gatewayId,
		gatewayEnrolled,
		gateways,
	};
}

/** The header block. Every row is a label and a value; a value that is absent reads as such in
 * plain words, so a glance tells set from unset without reading. */
export function printSetupStatus(s: SetupStatus): void {
	const row = (label: string, value: string, tail = ""): void => {
		console.log(`  ${label.padEnd(13)}${value}${tail ? `   ${tail}` : ""}`);
	};
	// The Router binds the first address, so the list order answers "which one is it on". A bound
	// address missing from the list is a machine that moved, which only a restart re-binds.
	const drifted = s.lanBound && !s.lanHosts.includes(s.lanBound);
	// FIRST, and only when it is in the way. Nothing below can change while docker is unreachable,
	// so an operator reading top-down meets the blocker before the rows it makes meaningless.
	if (s.dockerBlocker) row("Docker", s.dockerBlocker, "pick 1 or 2 for the fix");
	row(
		"LAN",
		s.lanHosts.join(", ") || s.lanBound || "none",
		drifted ? `Router bound to ${s.lanBound}, restart ./start-federation.sh` : "",
	);
	// Public reach is the local Router's own setting, so it says nothing on a machine that only
	// dials one; that machine's Router row carries the remote address instead.
	if (!s.remoteRouter) row("Public", s.publicHost ? `${s.publicHost}:${s.publicPort}` : "not set");
	row("Router", s.routerRunning ? "running" : s.remoteRouter ? `${s.remoteRouter}   remote` : "not running");
	if (!s.remoteRouter) {
		row("Fingerprint", s.certFingerprint ? shortFp(s.certFingerprint) : "--");
		row("Domain", s.domain);
	}
	const registered = s.gateways?.some((g) => g.gatewayId === s.gatewayId) ?? false;
	row("Gateway", s.gatewayEnrolled ? (registered ? "enrolled" : "enrolled, not registered") : "not enrolled");
	if (s.routerRunning) {
		console.log("\nGateways:");
		if (!s.gateways)
			console.log("  (could not ask the Router - is CONSOLE_BRIDGE_TOKEN in .env the one it runs with?)");
		else if (s.gateways.length === 0) console.log("  none registered");
		else
			for (const g of s.gateways)
				console.log(`  ${g.gatewayId.padEnd(13)}${g.signFp ?? "(no identity presented)"}`);
	}
	console.log("  ----------------------------------------------------------------");
}
