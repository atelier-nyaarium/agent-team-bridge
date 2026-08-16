// What the setup menu shows above the dial: the state every option's label and every next step
// depend on, read BEFORE the menu draws so the screen that orients the owner is not the one screen
// that knows nothing. Nothing here mutates.

import { $ } from "bun";
import { sanitizeGatewayId } from "../src/shared/gateway-id.js";
import { readAdminDomain } from "./bootstrap-domain.js";
import { detectLanHost, envGet, jparse } from "./lib/host.js";
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
	/** The LAN address this machine holds now, and the one the Router is bound to. They differ
	 * after a DHCP move until the next start. */
	lanNow: string;
	lanBound: string;
	publicHost: string;
	publicPort: number;
	routerRunning: boolean;
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
	const [lanNow, lanBound, reach, running, domainId, gatewayId, gatewayEnrolled] = await Promise.all([
		detectLanHost(),
		envGet("FEDERATION_BIND"),
		readPublicReach(),
		routerRunning(),
		envGet("FEDERATION_DOMAIN_ID"),
		// Sanitized the way the gateway sanitizes its own id at register, or `Sakura` in .env never
		// matches the `sakura` the Router holds and this machine reads as never registered.
		envGet("GATEWAY_ID").then((id) => sanitizeGatewayId(id || gatewayHostname())),
		transportInstalled(),
	]);

	let certFingerprint: string | null = null;
	let gateways: RegisteredGateway[] | null = null;
	let domain: SetupStatus["domain"] = "none";
	if (running) {
		const probeHost = lanBound || lanNow;
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
		lanNow,
		lanBound,
		publicHost: reach.publicHost,
		publicPort: reach.publicPort,
		routerRunning: running,
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
	const lanTail = s.lanBound && s.lanBound !== s.lanNow ? `now ${s.lanNow}, restart ./start-federation.sh` : "";
	row("LAN", s.lanBound || s.lanNow, lanTail);
	row("Public", s.publicHost ? `${s.publicHost}:${s.publicPort}` : "not set");
	row("Router", s.routerRunning ? "running" : "not running");
	row("Fingerprint", s.certFingerprint ? shortFp(s.certFingerprint) : "--");
	row("Domain", s.domain);
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
