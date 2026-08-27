// The two teardown paths off setup.ts's top dial menu: Purge Gateway (option 9, this machine only)
// and Purge Federation (option 0, the whole Domain). Both share the board-loss guard and the volume
// wipe; only Purge Federation mutates the Router's state.

import fs from "node:fs";
import { $ } from "bun";
import { sanitizeGatewayId } from "../src/shared/gateway-id.js";
import { removeDomain } from "./bootstrap-domain.js";
import { requireDocker } from "./lib/docker-probe.js";
import { confirm, dc, dcFederation, dirExists, envGet, envUnset } from "./lib/host.js";
import { readRouterFed, writeRouterFed } from "./lib/routerState.js";
import { confirmBoardLoss } from "./setup-board-guard.js";
import { BLOB_FILE, CONSOLE_JSON_FILE, GW_JSON_FILE, GW_QR_GIF, QR_GIF, SECRETS_DIR } from "./setup-constants.js";
import { gatewayHostname } from "./setup-gateway.js";

////////////////////////////////
//  Constants

/** The .env keys the GATEWAY's own setup writes (setup-gateway.ts, start-gateway.sh) and nothing
 * else does. Every other key in that file belongs to the Router (routerStart.ts, setup-provision.ts)
 * and a gateway purge must not know they exist. `FEDERATION_DOMAIN_ID` is the Router's: the gateway
 * compose passes it through as a fallback, but it is minted by Router Setup, which re-stages a
 * pending Domain OVER the rooted one when it finds the key absent. */
export const GATEWAY_ENV_KEYS = [
	"GATEWAY_ID",
	"HOST_WS_TOKEN",
	"FEDERATION_ROUTER_HOST",
	"FEDERATION_ROUTER_PORT",
] as const;

const HOST_DAEMON_TMUX = "host-daemon";

////////////////////////////////
//  Purge primitives (throw on failure; the menu catches per-op, the top level exits)

/** Erase both gateway volumes: volumes/gateway-data (all durable state) and volumes/gateway (logs).
 * The gateway writes them as the in-container user, so a host-side rm is denied; a root container
 * with the same mount clears them. */
async function wipeState(): Promise<void> {
	for (const dir of ["volumes/gateway-data", "volumes/gateway"]) {
		if (!dirExists(dir)) continue;
		const mount = `${process.cwd()}/${dir}:/w`;
		const sh = "cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true";
		if ((await $`docker run --rm -u 0 -v ${mount} busybox sh -c ${sh}`.quiet().nothrow()).exitCode !== 0) {
			throw new Error(`could not erase ${dir} (is docker running?)`);
		}
	}
}

/** Apply a purge mutation to the Router's federation state in place, best-effort. Stops the Router
 * (its store is single-writer, so a write under a live one is lost), runs `mutate` over the state
 * file, then brings it back. A no-op when no admin Domain id is set; failures are swallowed so the
 * local wipe always proceeds, since a purge must not stall on a Router that will not start. */
async function federationDelete(mutate: (fedJson: string) => string): Promise<void> {
	const domain = await envGet("FEDERATION_DOMAIN_ID");
	if (!domain) return;
	try {
		await dcFederation("stop").quiet().nothrow();
		const fed = await readRouterFed();
		if (fed) await writeRouterFed(mutate(fed));
	} catch {
	} finally {
		await dcFederation("start").quiet().nothrow();
	}
}

/** Stop the host daemon's tmux session. It exists only to serve this machine's gateway, and left
 * running it reconnects forever to a container that no longer exists. Exact-match `=name`, the
 * same form start-host-daemon.sh uses, so `host-daemon-2` is never the one killed.
 *
 * tmux is probed on its own first: Bun's shell answers a missing binary with the same exit 1 that
 * `has-session` answers "no such session" with, so without the probe a Windows machine, which has
 * no tmux, would be told the daemon "was not running" by a check that could not look. */
async function stopHostDaemon(): Promise<string> {
	if ((await $`tmux -V`.quiet().nothrow()).exitCode !== 0) return "no tmux on this machine, nothing to stop";
	const has = await $`tmux has-session -t ${`=${HOST_DAEMON_TMUX}`}`.quiet().nothrow();
	if (has.exitCode !== 0) return "was not running";
	const kill = await $`tmux kill-session -t ${`=${HOST_DAEMON_TMUX}`}`.quiet().nothrow();
	return kill.exitCode === 0 ? "stopped" : "could not be stopped (tmux kill-session failed)";
}

////////////////////////////////
//  Top-level operations

/**
 * Remove this machine's gateway and nothing else.
 *
 * What it can do: stop the daemon and the container, erase both volumes, and take the gateway's own
 * keys out of .env. What it CANNOT do is tell the network: an admission is an owner-signed fact and
 * every mirror of it (the Router, every other Gateway, the phone's keyring) retires one only on an
 * owner-signed revocation, which this host cannot produce - the owner's SIGNING key never leaves the
 * phone. Editing the admission out of the Router's file was tried: it reached the Router at once and
 * the other Gateways at their next register, at the cost of bouncing the Router and dropping all of
 * them, but never the phone, whose keyring unions and so kept listing the ghost and reading its
 * board. The one thing that finishes the job is named here, not faked.
 */
export async function purgeGateway(): Promise<void> {
	// Before anything is stopped. The wipe runs through docker, so with docker down the purge would
	// otherwise kill the daemon, fail at the volumes, and leave a gateway that comes back on its own
	// with nothing serving its host slot.
	await requireDocker();
	const gw = sanitizeGatewayId((await envGet("GATEWAY_ID")) || gatewayHostname());
	console.log(`Purge Gateway "${gw}"\n`);
	console.log("Removes the gateway on this machine and nothing else:");
	console.log("  - stops the host daemon and the gateway container");
	console.log("  - erases volumes/gateway-data and volumes/gateway (its keys, sessions, mailboxes, task board)");
	console.log(`  - drops its keys from .env (${GATEWAY_ENV_KEYS.join(", ")})`);
	console.log("A Federation Router on this machine, its tokens and its Domain are not touched.\n");
	if (!confirm(`Purge gateway "${gw}"?`)) return;
	if (!(await confirmBoardLoss())) return;

	const report = (step: string, outcome: string): void => console.log(`  ${step.padEnd(14)}${outcome}`);
	console.log();
	report("host daemon", await stopHostDaemon());
	const down = await dc("down", "--remove-orphans").quiet().nothrow();
	report(
		"gateway",
		down.exitCode === 0 ? "stopped" : "compose down failed (continuing; the volumes are wiped below)",
	);
	// A wipe that did not happen must not be followed by the .env cleanup below, or the machine is
	// left with a gateway that restarts on its own having lost its token. Stop here and say so; every
	// step above is safe to repeat.
	try {
		await wipeState();
	} catch (e) {
		report("volumes", `FAILED: ${e instanceof Error ? e.message : String(e)}`);
		console.log("\nThe purge did NOT complete. Fix the cause and run 9) again; repeating it is safe.");
		return;
	}
	report("volumes", "erased");
	const remaining = await envUnset(GATEWAY_ENV_KEYS);
	report(".env", remaining === 0 ? "removed (nothing else was in it)" : "gateway keys removed");
	await $`rm -f ${GW_QR_GIF} ${GW_JSON_FILE}`.quiet().nothrow();
	console.log(`\nGateway "${gw}" is purged from this machine.\n`);
	console.log(`Its admission is still in your Domain. This script cannot revoke it - only you can, in the app:`);
	console.log(`  Settings > Domain & Trust > Gateways > "${gw}" > Revoke`);
	console.log(`Until then it shows there as offline and keeps its task-board column. Revoke it BEFORE`);
	console.log(`enrolling this machine again, or the app lists "${gw}" twice.`);
}

/** Clean break: delete this owner's whole Domain from the Router, then erase the local state with
 * the same full wipe as Purge gateway so a re-provision starts fresh. A hosted friend tenant
 * survives. */
export async function purgeFederation(): Promise<void> {
	console.log("Wipes the network from the Router, plus .env + both gateway volumes + the host blob.");
	if (!confirm("Purge everything?")) return;
	if (!(await confirmBoardLoss())) return;

	const domain = await envGet("FEDERATION_DOMAIN_ID");
	await federationDelete((fed) => removeDomain(fed, domain));
	await dc("down", "--remove-orphans").quiet().nothrow();
	await wipeState();
	await $`rm -f .env ${BLOB_FILE} ${QR_GIF} ${CONSOLE_JSON_FILE} ${GW_QR_GIF} ${GW_JSON_FILE}`.quiet().nothrow();
	// A non-recursive rmdir only succeeds on an empty dir, so this tidies the blob's home without
	// touching other secrets; a non-empty dir throws and is ignored.
	try {
		fs.rmdirSync(SECRETS_DIR);
	} catch {}
	console.log("Purged.");
}
