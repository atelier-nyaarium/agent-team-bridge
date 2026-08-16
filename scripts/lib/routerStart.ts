import { randomBytes } from "node:crypto";
import { $ } from "bun";
import { dcFederation, detectLanHost, envGet, envSet, jparse, note, secureFile } from "./host.js";
import { routerRunning } from "./routerState.js";

////////////////////////////////
//  Constants
//
//  Bringing the federation Router up, shared by start-federation.ts and the setup menu's Admin
//  Provision so there is ONE place that decides what .env holds. Every key the Router reads is
//  written here or by the provision prompt; nothing is left for the owner to hand-edit.

export const ROUTER_PORT = 20001;
const NETWORK = "switchboard-federation";
const HEALTH_TRIES = 30;
const HEALTH_INTERVAL_MS = 2000;

////////////////////////////////
//  Interfaces & Types

export interface RouterEnv {
	/** The LAN address the Router binds and advertises. Detected, never typed. */
	lan: string;
	publicHost: string;
	publicPort: number;
}

////////////////////////////////
//  Functions & Helpers

/** The public reach as .env holds it. Empty host means LAN only; the port is meaningless without
 * a host and reads as the Router's own. */
export async function readPublicReach(): Promise<{ publicHost: string; publicPort: number }> {
	const publicHost = await envGet("FEDERATION_PUBLIC_HOST");
	const raw = Number(await envGet("FEDERATION_PUBLIC_PORT"));
	const publicPort = publicHost && Number.isInteger(raw) && raw > 0 ? raw : ROUTER_PORT;
	return { publicHost, publicPort };
}

/** Write the public reach. Both keys always land, an empty host as an empty value, so a later read
 * sees a decision rather than an absence. */
export async function writePublicReach(publicHost: string, publicPort: number): Promise<void> {
	await envSet("FEDERATION_PUBLIC_HOST", publicHost);
	await envSet("FEDERATION_PUBLIC_PORT", publicHost ? String(publicPort) : "");
	secureFile(".env");
}

/** Mint what is missing and write the LAN bind from detection. Runs on every start, so a DHCP move
 * lands in .env before compose reads it rather than binding an address this machine no longer holds.
 * Offline, the previous bind is kept: it is still the address the phone last learned. */
export async function ensureRouterEnv(): Promise<RouterEnv> {
	if (!(await envGet("CONSOLE_BRIDGE_TOKEN"))) await envSet("CONSOLE_BRIDGE_TOKEN", randomBytes(32).toString("hex"));
	if (!(await envGet("FEDERATION_WS_TOKEN"))) await envSet("FEDERATION_WS_TOKEN", randomBytes(32).toString("hex"));
	const detected = await detectLanHost();
	const previous = await envGet("FEDERATION_BIND");
	const lan = detected !== "0.0.0.0" ? detected : previous;
	if (!lan || lan === "127.0.0.1" || lan === "0.0.0.0") {
		throw new Error("no LAN address to bind the Router on: this machine has no route out and .env holds none");
	}
	if (lan !== previous) await envSet("FEDERATION_BIND", lan);
	secureFile(".env");
	const { publicHost, publicPort } = await readPublicReach();
	return { lan, publicHost, publicPort };
}

/** The Router's /health, or null when it does not answer. Probes the BOUND address: a LAN bind
 * unbinds loopback, so a localhost probe would report a healthy Router as down. */
export async function routerHealth(lan: string): Promise<{ certFingerprint: string; gateways: number } | null> {
	const text = await $`curl -sk --max-time 5 https://${lan}:${ROUTER_PORT}/health`.quiet().nothrow().text();
	const parsed = jparse<{ ok?: boolean; certFingerprint?: string; gateways?: number }>(text.trim());
	if (!parsed?.ok || !parsed.certFingerprint) return null;
	return { certFingerprint: parsed.certFingerprint, gateways: parsed.gateways ?? 0 };
}

/** Bring the Router up on what .env now says. Waits for /health and returns it, plus whether the
 * Router was already up, so a caller can say "ready" or "running" truthfully.
 *
 * `build` decides whether the image is rebuilt from the tree first. The start script always does,
 * since that is the path a code change ships through. Provision does NOT on a running Router: the
 * image copies the whole tree, so any edit since the last start yields a new image, and `up` then
 * recreates a Router whose reach never changed. That drops every gateway and reads as an outage
 * from a re-run that typed nothing. A running Router is only recreated here when its config moved. */
export async function startRouter(
	env: RouterEnv,
	opts: { build: boolean },
): Promise<{ certFingerprint: string; gateways: number; wasRunning: boolean }> {
	const wasRunning = await routerRunning();
	if (!wasRunning) note(`Starting the Router on ${env.lan}:${ROUTER_PORT}`);
	const inspect = await $`docker network inspect ${NETWORK}`.quiet().nothrow();
	if (inspect.exitCode !== 0) await $`docker network create ${NETWORK}`.quiet();
	const up = opts.build
		? await dcFederation("up", "--build", "-d").quiet().nothrow()
		: await dcFederation("up", "-d").quiet().nothrow();
	if (up.exitCode !== 0) {
		throw new Error(`docker compose up failed - the Router was never started\n${up.stderr.toString().trim()}`);
	}
	for (let i = 0; i < HEALTH_TRIES; i++) {
		const health = await routerHealth(env.lan);
		if (health) return { ...health, wasRunning };
		await Bun.sleep(HEALTH_INTERVAL_MS);
	}
	throw new Error("the Router did not become healthy within 60s - run: docker logs switchboard-federation");
}

/** The first 16 hex of a cert fingerprint, grouped in fours: the form an owner compares by eye. */
export function shortFp(certFingerprint: string): string {
	return (certFingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}
