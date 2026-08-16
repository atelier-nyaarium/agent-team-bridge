// This machine's gateway enrollment: arm it for enrollment and wait for the phone's bundle. Driven
// by setup.ts's top dial menu (option 1); the purge side of the gateway lifecycle is setup-purge.ts.

import { randomBytes } from "node:crypto";
import os from "node:os";
import { $ } from "bun";
import { ask, confirm, dc, detectLanHost, envGet, envSet, err, note, secureFile } from "./lib/host.js";
import { ROUTER_PORT } from "./lib/routerStart.js";
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
async function armGateway(): Promise<string> {
	const nonce = randomBytes(16).toString("hex");
	const host = await detectLanHost();
	console.log(`Starting gateway, enrollment on ${host}:20000`);
	await dc("down", "--remove-orphans").quiet().nothrow();
	await clearTransport();
	const up = await dc("up", "--build", "-d")
		.env({ ...process.env, ENROLL_NONCE: nonce, ENROLL_LAN_HOST: host })
		.nothrow();
	if (up.exitCode !== 0) throw new Error("could not start the gateway (is docker running?)");
	if (!(await waitHealth())) {
		throw new Error("gateway not ready in 60s - run: docker logs switchboard");
	}
	return nonce;
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
 * enrollment here while `loadEvieTransport` reads it as null and arms for enrollment. Same rule as
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

/** Wait for the phone to deliver the sealed bundle, by either the phone's LAN POST or a bundle the
 * user pastes here. The gateway writes transport.json the moment it installs a bundle, so that file
 * appearing is the success signal. Returns "installed" once it lands, or "back" if the user quits. */
async function waitForInstall(): Promise<"installed" | "back"> {
	console.log("\nWaiting for phone to deliver the bundle");
	for (;;) {
		// Give the phone's LAN delivery a few seconds to land before prompting, so the common case
		// needs no keypress.
		for (let i = 0; i < 5; i++) {
			if (await transportInstalled()) return "installed";
			await Bun.sleep(1000);
		}
		console.log("\n    Enter) Check again");
		console.log("    p) Paste the bundle here instead");
		console.log("    b) Back");
		const choice = ask("  >").toLowerCase();
		if (choice === "b") return "back";
		if (choice === "p") {
			const bundle = ask("Paste the bundle:");
			if (bundle && (await postPastedBundle(bundle))) return "installed";
		}
	}
}

/** Enroll THIS machine as a gateway, the same flow whether it is the first or the Nth. Names the
 * gateway, arms it for enrollment, shows its admit payload (as a QR or as JSON to copy), then waits
 * for the phone to deliver the connection bundle and restarts the gateway to connect. Any saved
 * artifact is wiped on success, on back-out, and on ^C. */
export async function setupGateway(): Promise<void> {
	// A downstream Gateway starts with no Domain knowledge. The Console that scans this QR already
	// owns the network and delivers the sealed enrollment bundle after the scan.

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
	const nonce = await armGateway();
	const payload = await readAdmitPayload(nonce);

	try {
		for (;;) {
			const action = await presentEnrollment(payload, {
				title: `Gateway "${id}" - send to your phone:`,
				continueLabel: "Done. Continue Enrollment",
				qrScanHint: "Scan this QR in your phone's Add Gateway screen.",
				jsonScanHint: "Paste the enrollment JSON into your phone's Add Gateway screen.",
				qrGifPath: GW_QR_GIF,
				jsonFilePath: GW_JSON_FILE,
				qrSaveLabel: "Save Enrollment QR Instead",
				jsonSaveLabel: "Save Enrollment JSON Instead",
			});
			if (action === "back") return;

			// Continue: wait for the bundle (LAN delivery or a paste), then connect.
			if ((await waitForInstall()) === "installed") {
				console.log();
				note(`Gateway "${id}" enrolled; connecting to the Router.`);
				return;
			}
		}
	} finally {
		cleanupTemps();
	}
}
