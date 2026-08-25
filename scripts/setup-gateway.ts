// This machine's gateway enrollment: arm it for enrollment and wait for the phone's bundle. Driven
// by setup.ts's top dial menu (option 1); the purge side of the gateway lifecycle is setup-purge.ts.

import { randomBytes } from "node:crypto";
import os from "node:os";
import { $ } from "bun";
import { fingerprint } from "../src/shared/crypto.js";
import { requireDocker } from "./lib/docker-probe.js";
import {
	ask,
	confirm,
	dc,
	detectLanHost,
	ensureHostWsToken,
	ensureNetwork,
	envGet,
	envSet,
	err,
	jparse,
	note,
	secureFile,
} from "./lib/host.js";
import { FEDERATION_NETWORK, ROUTER_PORT } from "./lib/routerStart.js";
import { routerRunning } from "./lib/routerState.js";
import {
	ADMIT_PAYLOAD_URL,
	ENROLL_URL,
	GW_JSON_FILE,
	GW_QR_GIF,
	HEALTH_URL,
	TRANSPORT_FILE_HOST,
} from "./setup-constants.js";
import { cleanupTemps, presentEnrollment } from "./setup-enrollment-ui.js";

////////////////////////////////
//  Gateway helpers

/** The gateway's own enrollment window, mirrored here only to count it down. The gateway owns the
 * real timer (src/gateway/index.ts, enterArming); this is a display of it, so a drift makes the
 * countdown wrong rather than the window. */
const ENROLL_WINDOW_MS = 600_000;

export function gatewayHostname(): string {
	return os.hostname().trim();
}

/** Poll the gateway's /health until ready (30 x 2s = 60s). */
async function waitHealth(): Promise<boolean> {
	console.log("Waiting for gateway");
	for (let i = 0; i < 30; i++) {
		try {
			if ((await fetch(HEALTH_URL)).ok) return true;
		} catch {
			// Gateway not accepting connections yet - retry below.
		}
		await Bun.sleep(2000);
	}
	return false;
}

////////////////////////////////
//  Gateway operations (throw on failure; the menu catches per-op, the top level exits)

/** Delete the gateway's container-owned transport.json so the next boot arms for enrollment and the
 * install-wait starts clean. */
async function clearTransport(): Promise<void> {
	if (!(await Bun.file(TRANSPORT_FILE_HOST).exists())) return;
	const mount = `${process.cwd()}/volumes/gateway-data:/w`;
	await $`docker run --rm -u 0 -v ${mount} busybox rm -f /w/federation/transport.json`.quiet().nothrow();
}

/**
 * Where THIS machine first knocks on the Router. Asked once, before arming.
 *
 * The bundle the phone seals also names an address, but the phone knows the Router by its PUBLIC
 * host, and a machine on the same LAN as the Router would then have to hairpin out and back to make
 * its very first connection - with nothing learned yet to fall back to. So the operator names a door
 * that works from where this machine actually stands.
 *
 * It is only the first knock, never the trust: the fingerprint and bearer arrive sealed in the
 * bundle, so a wrong address fails to connect and cannot redirect anything. After the first register
 * the Router's own advertised addresses lead the ring and this falls to last.
 *
 * On the Router's own machine the answer is the compose alias, which is why that is the default there.
 */
async function askRouterBootstrap(): Promise<void> {
	const localRouter = await routerRunning();
	const currentHost = (await envGet("FEDERATION_ROUTER_HOST")) || (localRouter ? "federation-router" : "");
	const currentPort = Number(await envGet("FEDERATION_ROUTER_PORT")) || ROUTER_PORT;
	if (!process.stdin.isTTY) return;
	const host = ask(`Federation router host [${currentHost || "none"}]:`) || currentHost;
	if (!host) throw new Error("a Federation Router host is required to enroll this gateway");
	const portAnswer = ask(`Federation router port [${currentPort}]:`);
	const port = portAnswer === "" ? currentPort : Number(portAnswer);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${portAnswer}`);
	await envSet("FEDERATION_ROUTER_HOST", host);
	await envSet("FEDERATION_ROUTER_PORT", String(port));
	secureFile(".env");
}

/** Bring the gateway up with a fresh one-time enrollment nonce and its LAN address, so it opens the
 * /enroll listener and writes its admit payload. Each call arms a new nonce, so a slow scan never
 * hits the gateway's ~10 min one-shot window. */
async function armGateway(): Promise<{ nonce: string; deadline: number }> {
	const nonce = randomBytes(16).toString("hex");
	const host = await detectLanHost();
	console.log(`Starting gateway, enrollment on ${host}:20000`);
	// Compose declares this network external and will not create it. A machine that runs the Router
	// has one already; a gateway-only machine does not, and compose then refuses to start anything.
	await ensureNetwork(FEDERATION_NETWORK);
	// Before `up`, so the container starts holding it: without this the host slot is fail-closed and
	// the daemon can never attach, leaving a correctly-enrolled gateway with nothing to show.
	await ensureHostWsToken();
	await dc("down", "--remove-orphans").quiet().nothrow();
	await clearTransport();
	const up = await dc("up", "--build", "-d")
		.env({ ...process.env, ENROLL_NONCE: nonce, ENROLL_LAN_HOST: host })
		.nothrow();
	// Carry compose's own last words. "is docker running?" was the whole message once, and it is a
	// guess that reads as authoritative - on the machine that hit the missing network, docker was
	// running perfectly and the message sent the operator to check the one thing that was fine.
	if (up.exitCode !== 0) {
		const detail = up.stderr.toString().trim().split("\n").slice(-3).join("\n");
		throw new Error(`could not start the gateway${detail ? `:\n${detail}` : ""}`);
	}
	// The gateway starts its own window when the container reaches its arming code, which is after
	// this returns, and setup only learns of it later still. Stamped HERE so the countdown runs EARLY
	// rather than late: time shown that has already gone is the one direction that is not safe to be
	// wrong in, and health-wait plus payload-fetch can otherwise eat 75s of it unaccounted.
	const deadline = Date.now() + ENROLL_WINDOW_MS;
	if (!(await waitHealth())) {
		throw new Error("gateway not ready in 60s - run: docker logs switchboard");
	}
	return { nonce, deadline };
}

/** How much of the enrollment window is left, as the line the settling screen rewrites in place. */
function windowStatus(deadline: number): string {
	const left = deadline - Date.now();
	if (left <= 0) return "Enrollment window expired - press r to arm again.";
	const secs = Math.floor(left / 1000);
	return `Waiting for your phone... ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} left`;
}

/** The fingerprint the phone shows on its own confirm screen, from the same signing key the admit
 * payload carries. Both sides run the same function over the same bytes, so a mismatch is a
 * different gateway rather than a formatting difference. Without this the phone asks the admin to
 * "confirm this matches the Gateway terminal" over a terminal that displayed no such value. */
function sasOf(payload: string): string {
	const signPub = jparse<{ signPub?: string }>(payload)?.signPub;
	return signPub ? fingerprint(signPub) : "(this payload carried no signing key)";
}

/** A gateway that minted no enrollment cert offers no `lan` block, so the phone has no target to
 * deliver to and only a paste can reach it. Said on the screen rather than left in `docker logs`,
 * where the admin would wait out the whole window for a delivery that cannot arrive. */
function lanNoteOf(payload: string): string | undefined {
	if (jparse<{ lan?: unknown }>(payload)?.lan) return undefined;
	return "This gateway opened no LAN listener, so your phone cannot deliver to it. Use Paste below.";
}

/** Fetch the admit payload the gateway holds in memory while arming, gated by the enroll nonce we
 * armed it with so the nonce + box key are not served unauthenticated on the LAN port. */
async function readAdmitPayload(nonce: string): Promise<string> {
	for (let i = 0; i < 15; i++) {
		try {
			const res = await fetch(ADMIT_PAYLOAD_URL, { headers: { "x-enroll-nonce": nonce } });
			if (res.ok) {
				const text = (await res.text()).trim();
				if (text) return text;
			}
		} catch {
			// Gateway not up yet, or a dropped read - retry below.
		}
		await Bun.sleep(1000);
	}
	throw new Error(`no enrollment payload from ${ADMIT_PAYLOAD_URL} - run: docker logs switchboard`);
}

/** POST a pasted sealed bundle to the gateway's /enroll listener (the same intake the phone's LAN
 * POST hits). Returns whether the gateway accepted and installed it. */
async function postPastedBundle(bundle: string): Promise<boolean> {
	try {
		const res = await fetch(ENROLL_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: bundle,
		});
		if (res.ok) return true;
		const detail = await res.text().catch(() => "");
		err(`bundle rejected (HTTP ${res.status}) ${detail}`.trim());
		return false;
	} catch (e) {
		err(`gateway unreachable: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** True once transport.json holds the direct branch the gateway itself accepts. Existence alone is
 * not the signal: a truncated file, or one still in the retired k8s shape, would read as a successful
 * enrollment here while `loadRouterTransport` reads it as null and arms for enrollment. Same rule as
 * that loader, or the two answer opposite things about one file. */
export async function transportInstalled(): Promise<boolean> {
	const text = await readTransportText();
	if (!text) return false;
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		return raw.transport === "direct" && !!raw.routerUrl && !!raw.routerCertFp && !!raw.bearer;
	} catch {
		return false;
	}
}

/** transport.json's text, or null when absent. The gateway writes it as root at 0600, so the host
 * cannot open it directly once the container has; read through a container then, the way the Router
 * state is read. A direct read that fails for any other reason is a real absence. */
async function readTransportText(): Promise<string | null> {
	const file = Bun.file(TRANSPORT_FILE_HOST);
	if (!(await file.exists())) return null;
	try {
		return await file.text();
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EACCES") return null;
	}
	const mount = `${process.cwd()}/volumes/gateway-data:/w:ro`;
	const read = await $`docker run --rm -v ${mount} busybox cat /w/federation/transport.json`.quiet().nothrow();
	return read.exitCode === 0 ? read.stdout.toString() : null;
}

/** Enroll THIS machine as a gateway, the same flow whether it is the first or the Nth. Names the
 * gateway, arms it for enrollment, then shows its admit payload beside the code the phone must
 * match, ON the same screen that waits for the phone's bundle. Any saved artifact is wiped on
 * success, on back-out, and on ^C. */
export async function setupGateway(): Promise<void> {
	// A downstream Gateway starts with no Domain knowledge. The Console that scans this QR already
	// owns the network and delivers the sealed enrollment bundle after the scan.

	// Before anything is asked. Every step below ends in `docker compose up`, so a stopped daemon
	// otherwise fails at the LAST one, after the operator has typed a Router address for nothing.
	await requireDocker();

	// The gateway is named by this machine's hostname; a pre-set GATEWAY_ID overrides it for
	// duplicate hostnames, so there is no name prompt.
	const id = (await envGet("GATEWAY_ID")) || gatewayHostname();
	await envSet("GATEWAY_ID", id);
	secureFile(".env");

	// An already-enrolled gateway has a delivered transport; re-enrolling disconnects it until a new
	// bundle arrives, so confirm before re-arming.
	if (await transportInstalled()) {
		if (!confirm(`Gateway "${id}" already enrolled. Re-enroll?`)) return;
	}

	await askRouterBootstrap();
	let armed = await armGateway();
	let payload = await readAdmitPayload(armed.nonce);

	try {
		for (;;) {
			// One screen: the payload, the code the phone must match, and the wait. There is no
			// advance action between them any more, which is what used to let an admin walk past the
			// comparison without making it and then have no way back to it.
			const action = await presentEnrollment(payload, {
				title: `Gateway "${id}" - send to your phone:`,
				qrScanHint: "Scan this QR in your phone's Add Gateway screen.",
				jsonScanHint: "Paste the enrollment JSON into your phone's Add Gateway screen.",
				qrGifPath: GW_QR_GIF,
				jsonFilePath: GW_JSON_FILE,
				qrSaveLabel: "Save Enrollment QR Instead",
				jsonSaveLabel: "Save Enrollment JSON Instead",
				settle: {
					installed: transportInstalled,
					status: () => windowStatus(armed.deadline),
					expired: () => Date.now() >= armed.deadline,
					sas: sasOf(payload),
					lanNote: lanNoteOf(payload),
				},
			});
			if (action === "back") return;
			// A fresh nonce and a fresh window, without making the admin leave and re-enter setup.
			if (action === "rearm") {
				armed = await armGateway();
				payload = await readAdmitPayload(armed.nonce);
				continue;
			}
			if (action === "paste") {
				const bundle = ask("Paste the bundle:");
				if (!bundle || !(await postPastedBundle(bundle))) {
					err("The gateway did not accept that bundle.");
					continue;
				}
			} else if (action !== "settled") {
				continue;
			}
			console.log();
			note(`Gateway "${id}" enrolled; connecting to the Router.`);
			// An enrolled gateway with no daemon registers fine and then shows NOTHING on the phone:
			// the daemon is what owns the devcontainer catalog and the host spawn point, so without it
			// this machine has no sessions to list and reads as a failed enrollment.
			note("Next: run ./start-host-daemon.sh here, or this machine stays empty on your phone.");
			return;
		}
	} finally {
		cleanupTemps();
	}
}
