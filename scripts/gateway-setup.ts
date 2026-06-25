// Gateway setup - configure or LAN-enroll this machine's gateway. Driven by start-gateway.sh, which
// keeps the plain no-arg start in bash and execs this for --setup / --enroll.
//
//   --setup   menu: Configure (.env + restart) or Purge (erase .env + data).
//   --enroll  creds-less LAN enrollment: arm a one-time nonce, start the gateway, and print the
//             admit-gateway QR for the admin Console to scan.
//
// One gateway per machine, configured by .env (GATEWAY_ID, FEDERATION_OWNER_SIGN_PUB).

import { $ } from "bun";
import { ask, confirm, dc, die, envGet, envSet, menu } from "./lib/host.js";

const HEALTH_URL = "http://localhost:20000/health";

////////////////////////////////
//  Helpers

async function hostname(): Promise<string> {
	return (await $`hostname`.text()).trim();
}

/** docker logs for the gateway container, stdout + stderr merged (the logs split across both). */
async function gatewayLogs(): Promise<string> {
	const r = await $`docker logs switchboard`.quiet().nothrow();
	return [r.stdout.toString(), r.stderr.toString()].join("\n");
}

/** The inclusive line range from the first line containing `start` to the next containing `end`,
 * like sed's /start/,/end/p. Empty when `start` is never seen. */
function logRange(text: string, start: string, end: string): string {
	const out: string[] = [];
	let inRange = false;
	for (const line of text.split("\n")) {
		if (!inRange && line.includes(start)) inRange = true;
		if (inRange) {
			out.push(line);
			if (line.includes(end)) break;
		}
	}
	return out.join("\n").trim();
}

/** Poll the gateway's /health until ready (30 x 2s = 60s). */
async function waitHealth(): Promise<boolean> {
	console.log("Waiting for the gateway to be ready...");
	for (let i = 0; i < 30; i++) {
		if ((await $`curl -sf ${HEALTH_URL}`.quiet().nothrow()).exitCode === 0) return true;
		await Bun.sleep(2000);
	}
	return false;
}

/** Print the admit-gateway QR from the container logs, or say why there is not one. The gateway
 * logs the block as "... is not yet admitted ..." / "... open Add Gateway and scan:" / the QR /
 * "Confirm this fingerprint ..." (federation/enrollQr.ts), so slice between the first and last. */
async function printQr(): Promise<void> {
	const qr = logRange(await gatewayLogs(), "is not yet admitted", "Confirm this fingerprint");
	console.log();
	if (qr) {
		console.log("Admit-gateway QR (scan with the owner console, confirm the fingerprint):");
		console.log(qr);
	} else {
		console.log("No admit-gateway QR found. Expected when the Gateway is already admitted or has");
		console.log("no delivered transport (standalone); otherwise inspect: docker logs switchboard");
	}
}

/** A gateway is part of the mesh once a service-proxy transport has been delivered into its
 * federation dir (by provision-console.sh / enrollment). Absent = standalone, no mesh. */
async function hasTransport(): Promise<boolean> {
	return (await $`test -f volumes/gateway/federation/transport.json`.quiet().nothrow()).exitCode === 0;
}

/** Erase volumes/gateway. The gateway writes it as the in-container user, so a host-side rm is
 * denied; a root container with the same mount clears it. */
async function wipeState(): Promise<void> {
	if ((await $`test -d volumes/gateway`.quiet().nothrow()).exitCode !== 0) return;
	const mount = `${process.cwd()}/volumes/gateway:/w`;
	const sh = "cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true";
	if ((await $`docker run --rm -u 0 -v ${mount} busybox sh -c ${sh}`.quiet().nothrow()).exitCode !== 0) {
		throw new Error("could not erase volumes/gateway (is docker running?)");
	}
}

////////////////////////////////
//  Operations (throw on failure; the menu catches per-op, the top level exits)

/** Prompt for GATEWAY_ID / owner key, write .env, then rebuild + start the gateway. A gateway joins
 * the mesh once a service-proxy transport has been delivered (enrollment); when one is present, show
 * its admit-gateway QR. */
async function configure(): Promise<void> {
	const host = await hostname();
	const curId = await envGet("GATEWAY_ID");
	const curOwner = await envGet("FEDERATION_OWNER_SIGN_PUB");

	// The Gateway is named by the device hostname; a pre-set GATEWAY_ID is the escape hatch for
	// duplicate hostnames, so there is no nickname prompt.
	const id = curId || host;

	// FEDERATION_OWNER_SIGN_PUB pins which owner this Gateway trusts (the base64 key from the app's
	// owner screen) so a compromised evie cannot re-root it. Optional: blank = trust on first enroll.
	const ownerKey =
		ask(`Owner key (optional, blank = trust on first enroll)${curOwner ? " [keep]" : ""}:`) || curOwner;

	await envSet("GATEWAY_ID", id);
	await envSet("FEDERATION_OWNER_SIGN_PUB", ownerKey);
	await $`chmod 600 .env`.quiet().nothrow();

	// A delivered transport is what puts this gateway on the mesh; without one it runs standalone.
	const mesh = await hasTransport();
	console.log(mesh ? "Building and starting..." : "Building and starting (standalone, no mesh)...");
	if ((await dc("up", "--build", "-d").nothrow()).exitCode !== 0) throw new Error("docker compose up failed");
	if (!(await waitHealth())) {
		// The gateway fails closed at boot when FEDERATION_DOMAIN_ID is unset, which surfaces only as
		// a health timeout. Name that cause so a setup/enroll run is diagnosable without reading logs.
		const domHint = (await envGet("FEDERATION_DOMAIN_ID"))
			? ""
			: " (FEDERATION_DOMAIN_ID is unset; the gateway fails closed at boot without it - set it in .env first)";
		throw new Error(`did not come up in 60s - run: docker logs switchboard${domHint}`);
	}
	console.log(`Gateway "${id}" running on :20000.`);
	if (mesh) {
		await Bun.sleep(6000);
		await printQr();
	}
}

/** Wipe this machine's gateway setup (.env + volumes/gateway) back to nothing. */
async function purge(): Promise<void> {
	console.log("Wipes .env + volumes/gateway (keypair, admissions, mailboxes).");
	console.log("Re-configuring mints a new keypair, so the owner Console must re-admit this Gateway.");
	if (!confirm("Purge everything?")) return;
	await dc("down", "--remove-orphans").quiet().nothrow();
	await wipeState();
	await $`rm -f .env`.quiet().nothrow();
	console.log("Purged. Run Configure to set it up fresh.");
}

/** Creds-less LAN enrollment: arm a one-time nonce + advertise this host's LAN address, start the
 * gateway so it prints the admit-gateway QR, and wait for the admin Console to deliver a sealed
 * bundle. After delivery, a plain start connects via the installed service-proxy transport. */
async function enroll(): Promise<void> {
	const nonce = (await $`openssl rand -hex 16`.text()).trim();
	const hostLine = (await $`hostname -I`.quiet().nothrow()).text().trim();
	const host = hostLine.split(/\s+/)[0] || "0.0.0.0";
	console.log(`Arming one-time LAN enrollment on ${host}:20000 (nonce ${nonce.slice(0, 8)}...).`);
	await dc("down", "--remove-orphans").quiet().nothrow();
	const up = await dc("up", "--build", "-d")
		.env({ ...process.env, ENROLL_NONCE: nonce, ENROLL_LAN_HOST: host })
		.nothrow();
	if (up.exitCode !== 0) throw new Error("docker compose up failed");
	if (!(await waitHealth())) {
		// The gateway fails closed at boot when FEDERATION_DOMAIN_ID is unset, which surfaces only as
		// a health timeout. Name that cause so a setup/enroll run is diagnosable without reading logs.
		const domHint = (await envGet("FEDERATION_DOMAIN_ID"))
			? ""
			: " (FEDERATION_DOMAIN_ID is unset; the gateway fails closed at boot without it - set it in .env first)";
		throw new Error(`did not come up in 60s - run: docker logs switchboard${domHint}`);
	}
	await Bun.sleep(4000);
	console.log();
	const qr = logRange(await gatewayLogs(), "is not yet admitted", "Waiting for the admin Console");
	if (qr) {
		console.log("Scan this with the admin Console (Add Gateway). It carries the LAN target + nonce:");
		console.log(qr);
	} else {
		console.log("Could not find the admit-gateway QR in the logs - inspect: docker logs switchboard");
	}
	console.log();
	console.log("When the Console reports the Gateway delivered, run ./start-gateway.sh to connect.");
}

/** Top dial menu (interactive --setup). */
async function gatewayMenu(): Promise<void> {
	await menu(`Switchboard - Gateway setup on ${await hostname()}`, [
		{ key: "1", label: "Configure     - Set up .env and restart the gateway", run: configure },
		{ key: "0", label: "Purge configs - Erase .env, identity, and data", run: purge },
	]);
}

////////////////////////////////
//  Entry

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "";
	switch (arg) {
		case "--setup":
			if (!process.stdin.isTTY) die("--setup needs an interactive terminal");
			await gatewayMenu();
			break;
		case "--enroll":
			await enroll();
			break;
		default:
			die(`unknown option: ${arg} (expected --setup or --enroll)`);
	}
}

// .env carries the owner key; umask 077 writes it 0600 from birth.
process.umask(0o077);
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
