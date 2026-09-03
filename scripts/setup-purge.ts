// The two teardown paths off setup.ts's top dial menu: Purge Gateway (option 9, this machine only)
// and Purge Federation (option 0, the whole Domain). Both share the board-loss guard and the volume
// wipe; only Purge Federation mutates the Router's state.

import fs from "node:fs";
import { $ } from "bun";
import { sanitizeGatewayId } from "../src/shared/gateway-id.js";
import { findAdminDomainId, hasDomain, removeDomain } from "./bootstrap-domain.js";
import { requireDocker } from "./lib/docker-probe.js";
import { confirm, dc, dcFederation, dirExists, envGet, envUnset } from "./lib/host.js";
import { readRouterFed, routerRunning, writeRouterFed } from "./lib/routerState.js";
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

/** Apply a mutation to the Router's federation state in place. Stops the Router (its store is
 * single-writer, so a write under a live one is lost), runs `mutate` over the state file, then
 * brings it back whatever happened. ANSWERS what it did rather than swallowing: a purge that reports
 * success over a Domain it never removed cannot be retried, because its own next run reads the
 * Domain id from .env and that is what the purge takes out. */
async function federationDelete(
	mutate: (fedJson: string) => string,
	done: string,
): Promise<{ ok: boolean; outcome: string }> {
	let result: { ok: boolean; outcome: string };
	try {
		await dcFederation("stop").quiet().nothrow();
		// The stop's own exit code says little (a Router that was never up "stops" fine), so ask the
		// one question that matters before writing under it.
		if (await routerRunning()) {
			result = {
				ok: false,
				outcome: "could not stop the Router, so its state was not touched (nothing removed)",
			};
		} else {
			const fed = await readRouterFed();
			if (!fed) {
				result = { ok: false, outcome: "could not read the Router's state file (nothing removed)" };
			} else {
				await writeRouterFed(mutate(fed));
				result = { ok: true, outcome: done };
			}
		}
	} catch (e) {
		result = { ok: false, outcome: `${e instanceof Error ? e.message : String(e)} (nothing removed)` };
	}
	// Brought back whatever happened above, and a failure here is part of the answer: a Router left
	// down takes every tenant with it, which the summary line must not read as a clean purge.
	const start = await dcFederation("start").quiet().nothrow();
	if (start.exitCode !== 0) result.outcome += "; the Router did NOT come back up, run ./start-federation.sh";
	return result;
}

/** Stop the host daemon's tmux session. It exists only to serve this machine's gateway, and left
 * running it reconnects forever to a container that no longer exists. Exact-match `=name`, the
 * same form start-host-daemon.sh uses, so `host-daemon-2` is never the one killed.
 *
 * tmux is probed on its own first: Bun's shell answers a missing binary with the same exit 1 that
 * `has-session` answers "no such session" with, so without the probe a Windows machine, which has
 * no tmux, would be told the daemon "was not running" by a check that could not look. */
async function stopHostDaemon(): Promise<{ ok: boolean; outcome: string }> {
	if ((await $`tmux -V`.quiet().nothrow()).exitCode !== 0) {
		return { ok: true, outcome: "no tmux on this machine, nothing to stop" };
	}
	const has = await $`tmux has-session -t ${`=${HOST_DAEMON_TMUX}`}`.quiet().nothrow();
	if (has.exitCode !== 0) return { ok: true, outcome: "was not running" };
	const kill = await $`tmux kill-session -t ${`=${HOST_DAEMON_TMUX}`}`.quiet().nothrow();
	return kill.exitCode === 0
		? { ok: true, outcome: "stopped" }
		: { ok: false, outcome: "could not be stopped (tmux kill-session failed)" };
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
	console.log(
		"  - erases volumes/gateway-data and volumes/gateway (its keys, sessions, owner-row outbox, task board)",
	);
	console.log(`  - drops its keys from .env (${GATEWAY_ENV_KEYS.join(", ")})`);
	console.log("A Federation Router on this machine, its tokens and its Domain are not touched.\n");
	if (!confirm(`Purge gateway "${gw}"?`)) return;
	if (!(await confirmBoardLoss())) return;

	const report = (step: string, outcome: string): void => console.log(`  ${step.padEnd(14)}${outcome}`);
	console.log();
	const daemon = await stopHostDaemon();
	report("host daemon", daemon.outcome);
	if (!daemon.ok) {
		console.log("\nThe purge did NOT start: a daemon left running reconnects forever to a gateway that is gone.");
		console.log("Stop it by hand (tmux kill-session -t =host-daemon) and run 9) again.");
		return;
	}
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

/**
 * Delete this owner's Domain from the Router and take this machine's gateway with it, so a
 * re-provision starts from nothing. The Router itself, its tokens and every OTHER tenant stay:
 * `CONSOLE_BRIDGE_TOKEN` and `FEDERATION_WS_TOKEN` are what a hosted friend's consoles and Gateways
 * present, so deleting .env whole (which this did) locked them out at the Router's next start while
 * claiming the friend survived. The Domain id goes, since the Domain it names no longer exists and
 * Router Setup stages a fresh one only when the key is absent.
 *
 * The Router step runs FIRST and a failure stops the purge: the Domain id is the one thing a retry
 * needs, and it is what the local half removes. The id itself comes from .env OR from the Router's
 * own `isAdminDomain` mark, because the old purges deleted .env and left exactly the state where the
 * key is gone and the Domain is not - refusing then would strand the Domain forever.
 */
export async function purgeFederation(): Promise<void> {
	await requireDocker();
	// Read-only, so it needs no stop: the Router's file is what says whether there is anything here
	// to delete, and .env is only a hint at which slice.
	const fed = await readRouterFed();
	const domain = (await envGet("FEDERATION_DOMAIN_ID")) || (fed ? findAdminDomainId(fed) : null);
	if (!domain) {
		console.log("This machine's Router holds no Domain of yours to delete, and .env names none.");
		console.log("To remove its gateway, use 9) Purge Gateway.");
		return;
	}
	const present = fed !== "" && hasDomain(fed, domain);
	console.log(`Purge Federation (Domain ${domain})\n`);
	console.log("Deletes your Domain and this machine's gateway, so a re-provision starts from nothing:");
	console.log(
		present
			? `  - removes Domain ${domain} from the Router: its admissions, revocations and links`
			: `  - Domain ${domain} is already gone from the Router; only the local half is left to do`,
	);
	console.log("  - restarts the Router to write that; other tenants' Gateways and phones reconnect on their own");
	console.log("  - stops the host daemon and the gateway container, erases both gateway volumes");
	console.log("  - drops the gateway keys and FEDERATION_DOMAIN_ID from .env, and the saved setup code");
	console.log("The Router, its tokens and its public address stay, and so does every other tenant.\n");
	if (!confirm(`Delete Domain ${domain} and purge this gateway?`)) return;
	if (!(await confirmBoardLoss())) return;

	const report = (step: string, outcome: string): void => console.log(`  ${step.padEnd(14)}${outcome}`);
	console.log();
	const router = present
		? await federationDelete((json) => removeDomain(json, domain), `Domain ${domain} removed`)
		: { ok: true, outcome: `Domain ${domain} was already gone` };
	report("Router", router.outcome);
	if (!router.ok) {
		console.log("\nThe purge did NOT start. Fix the cause and run 0) again; nothing local was touched.");
		return;
	}
	const daemon = await stopHostDaemon();
	report("host daemon", daemon.outcome);
	if (!daemon.ok) {
		console.log("\nThe Domain is gone from the Router but this machine is NOT wiped: a daemon left running");
		console.log(
			"reconnects forever to a gateway that is gone. Stop it by hand (tmux kill-session -t =host-daemon)",
		);
		console.log("and run 9) Purge Gateway to finish; 9) does not need the Domain id.");
		return;
	}
	const down = await dc("down", "--remove-orphans").quiet().nothrow();
	report(
		"gateway",
		down.exitCode === 0 ? "stopped" : "compose down failed (continuing; the volumes are wiped below)",
	);
	try {
		await wipeState();
	} catch (e) {
		report("volumes", `FAILED: ${e instanceof Error ? e.message : String(e)}`);
		console.log("\nThe Domain is gone from the Router but this machine is NOT wiped. Fix the cause and run");
		console.log("9) Purge Gateway to finish; the Domain id in .env is stale now and 9) does not need it.");
		return;
	}
	report("volumes", "erased");
	const remaining = await envUnset([...GATEWAY_ENV_KEYS, "FEDERATION_DOMAIN_ID"]);
	report(".env", remaining === 0 ? "removed (nothing else was in it)" : "gateway keys and Domain id removed");
	await $`rm -f ${BLOB_FILE} ${QR_GIF} ${CONSOLE_JSON_FILE} ${GW_QR_GIF} ${GW_JSON_FILE}`.quiet().nothrow();
	// A non-recursive rmdir only succeeds on an empty dir, so this tidies the blob's home without
	// touching other secrets; a non-empty dir throws and is ignored.
	try {
		fs.rmdirSync(SECRETS_DIR);
	} catch {}
	report("setup code", "removed");
	console.log(`\nDomain ${domain} is deleted and this gateway is purged.\n`);
	// The app imports a setup code only while unprovisioned, so the phone has to forget first. The
	// in-app button shipped in 8.3.28; the storage clear is the same wipe for an app older than that,
	// since the script and the app update on separate triggers.
	console.log("Your phone still holds the old Domain. In the app: Settings > Domain & Trust > Forget this Domain.");
	console.log("On an app older than 8.3.28: Android Settings > Apps > Switchboard > Storage > Clear storage.");
	console.log("Then run 2) Router Setup for a new setup code, scan it, and 1) Gateway Setup to enroll this machine.");
}
