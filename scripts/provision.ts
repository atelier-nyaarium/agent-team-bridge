// Admin setup - the single bootstrap for this machine's gateway and the owner's Console. It
// configures + enrolls the gateway, roots the owner's own Domain, and emits the bridge blob the
// owner's Console imports. Driven by provision-admin-domain.sh, a thin launcher that execs this.
//
//   (no args)            interactive menu: set up this gateway, provision the admin Domain, or purge.
//                        Non-TTY runs Provision direct.
//   --gateway-transport  move the local Gateway off port-forward onto the service-proxy WS (run
//                        AFTER validating WS-over-proxy on this cluster).
//   --qr                 re-open the enrollment-QR menu for the current blob.
//   --verify             health-probe the bridge + report what is / is not set up.
//   --help
//
// Phone-anchored trust: the Domain ROOT private key is generated SILENTLY on the Console and never
// reaches the host, so this script never holds, prompts for, or roots with the owner key. Provision
// is a fresh-vs-reprovision state machine keyed on whether the admin Domain is already rooted in
// evie's federation Secret:
//   - FRESH (admin Domain absent / unrooted): the trusted host bootstrap (direct Secret access) pre-stages
//     the admin Domain as a PENDING tenant - an display name the admin types + a one-time invite
//     nonce, no owner root - and emits a transport-ONLY blob carrying `pendingTenant`. The admin's
//     phone reads it and first-roots the admin Domain at its silent owner key, exactly like a friend.
//   - RE-PROVISION (admin Domain already rooted): skip staging; emit the blob only (no `pendingTenant`),
//     preserving the existing display name.
// The blob is transport-only (cluster creds; no identity, no Gateway keys). The Console generates its
// own identity, admits itself, and admits each Gateway afterward.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { $ } from "bun";
import { ADMIT_PAYLOAD_FILE } from "../src/gateway/federation/enrollQr.js";
import { sanitizeDomainId } from "../src/shared/domain-id.js";
import { sanitizeGatewayId } from "../src/shared/host-id.js";
import { pendingAdminDomain, readAdminDomain, removeDomain, removeGatewayAdmission } from "./bootstrap-domain.js";
import {
	applySecret,
	ask,
	confirm,
	dc,
	die,
	dx,
	ensureContainer,
	envGet,
	envSet,
	err,
	jparse,
	k,
	kGetB64,
	kStdin,
	NS,
	note,
	readSaCreds,
	writeGatewayFile,
} from "./lib/host.js";
import { fitsInQr, renderQrImageGif, renderQrTerminal } from "./render-provisioning-qr.js";
import { writeProvisioningBlob } from "./write-provisioning-blob.js";

////////////////////////////////
//  Constants

const HEALTH_URL = "http://localhost:20000/health";
const ENROLL_URL = "http://localhost:20000/enroll";
// The gateway's federation dir on the host (bind-mounted from FED_DIR_IN inside the container).
const FED_DIR_HOST = "volumes/gateway/federation";
const TRANSPORT_FILE_HOST = `${FED_DIR_HOST}/transport.json`; // enrollment writes this once a bundle installs
const ADMIT_PAYLOAD_HOST = `${FED_DIR_HOST}/${ADMIT_PAYLOAD_FILE}`; // the raw admit payload the gateway writes while arming
const EVIE_DEPLOY = "deploy/evie-bot-deployment";
const FED_SECRET = "evie-federation";
const BRIDGE_YAML = "../evie-bot/deploy/console-bridge.yaml";
const GATEWAY_BRIDGE_YAML = "../evie-bot/deploy/gateway-bridge.yaml";
const SERVICE = "evie-console-bridge";
const PORT = 20004;
const FED_DIR_IN = "/app/log/federation"; // the gateway's federation dir (allowlist + keypair)
const SECRETS_DIR = `${process.env.HOME}/android-dev/secrets`;
const BLOB_FILE = `${SECRETS_DIR}/console-provisioning.json`; // the artifact the app imports
const QR_GIF = `${SECRETS_DIR}/console-enrollment-qr.gif`; // optional saved QR image (menu opt 2)
const OWNER_ID_FILE = `${SECRETS_DIR}/console-owner-identity.json`; // legacy host-minted owner (the phone holds it now)
// Temp artifacts Setup Gateway can save so a far-away phone can scan/paste off-screen. Always
// deleted on enrollment success, back-out, or ^C (see trackTemp / cleanupTemps).
const GW_QR_GIF = `${SECRETS_DIR}/gateway-admit-qr.gif`;
const GW_JSON_FILE = `${SECRETS_DIR}/gateway-admit.json`;

// The one-time invite lifetime for a freshly-staged pending admin Domain. Matches evie's
// DEFAULT_INVITE_TTL_MS (~1 day) so the admin has time to scan + connect; evie sweeps an
// unredeemed pending tenant at issuedAt + ttlMs.
const INVITE_TTL_MS = 86_400_000;

const USAGE = [
	"Admin setup - the SINGLE bootstrap for this gateway and the Android Console.",
	"",
	"  ./provision-admin-domain.sh              menu: set up the gateway, provision, purge (non-TTY runs Provision direct)",
	"  ./provision-admin-domain.sh --gateway-transport  move the local Gateway onto the service-proxy WS",
	"  ./provision-admin-domain.sh --qr                 re-open the enrollment-QR menu for the current blob",
	"  ./provision-admin-domain.sh --verify             health-probe the bridge",
	"  ./provision-admin-domain.sh --help",
].join("\n");

////////////////////////////////
//  Temp file cleanup (saved enrollment artifacts)

// Files Setup Gateway saved this run. They carry the gateway's enrollment payload, so they must
// never be left behind: cleaned on success, on back-out, and on ^C.
const tempFiles = new Set<string>();

function trackTemp(path: string): void {
	tempFiles.add(path);
}

function cleanupTemps(): void {
	for (const f of tempFiles) {
		try {
			fs.rmSync(f, { force: true });
		} catch {}
	}
	tempFiles.clear();
}

// Wipe any saved artifact if the user interrupts mid-enrollment, then exit.
process.on("SIGINT", () => {
	cleanupTemps();
	process.exit(130);
});

////////////////////////////////
//  kubectl read helpers (the typed Secret reads + apply live in lib/host.ts)

/** The cluster's apiserver URL (config view ignores -n, so k() is fine here). */
async function clusterApiUrl(): Promise<string> {
	const r = await k("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}").quiet().nothrow();
	return r.text().trim();
}

////////////////////////////////
//  Gateway helpers

async function gatewayHostname(): Promise<string> {
	return (await $`hostname`.text()).trim();
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
//  Gateway operations (throw on failure; the menu catches per-op, the top level exits)

/** Delete the gateway's container-owned transport.json so the next boot arms for enrollment and the
 * install-wait starts clean. */
async function clearTransport(): Promise<void> {
	if (!(await Bun.file(TRANSPORT_FILE_HOST).exists())) return;
	const mount = `${process.cwd()}/volumes/gateway:/w`;
	await $`docker run --rm -u 0 -v ${mount} busybox rm -f /w/federation/transport.json`.quiet().nothrow();
}

/** Bring the gateway up with a fresh one-time enrollment nonce and its LAN address, so it opens the
 * /enroll listener and writes its admit payload. Each call arms a new nonce, so a slow scan never
 * hits the gateway's ~10 min one-shot window. */
async function armGateway(): Promise<void> {
	const nonce = (await $`openssl rand -hex 16`.text()).trim();
	const hostLine = (await $`hostname -I`.quiet().nothrow()).text().trim();
	const host = hostLine.split(/\s+/)[0] || "0.0.0.0";
	console.log(`Starting the gateway and opening enrollment on ${host}:20000.`);
	await dc("down", "--remove-orphans").quiet().nothrow();
	await clearTransport();
	const up = await dc("up", "--build", "-d")
		.env({ ...process.env, ENROLL_NONCE: nonce, ENROLL_LAN_HOST: host })
		.nothrow();
	if (up.exitCode !== 0) throw new Error("could not start the gateway (is docker running?)");
	if (!(await waitHealth())) {
		throw new Error("The gateway didn't start within 60 seconds. Show its logs with: docker logs switchboard");
	}
}

/** Read the raw admit payload the gateway wrote while arming, polling briefly until it lands. */
async function readAdmitPayload(): Promise<string> {
	for (let i = 0; i < 15; i++) {
		const text = await Bun.file(ADMIT_PAYLOAD_HOST)
			.text()
			.catch(() => "");
		if (text.trim()) return text.trim();
		await Bun.sleep(1000);
	}
	throw new Error(
		`the gateway did not write its enrollment details (${ADMIT_PAYLOAD_HOST}) - check: docker logs switchboard`,
	);
}

/** Bring the gateway up normally (no enrollment nonce) so it connects with the delivered network id
 * and transport. */
async function connectGateway(): Promise<void> {
	console.log("Connecting the gateway to your network...");
	await dc("down", "--remove-orphans").quiet().nothrow();
	if ((await dc("up", "--build", "-d").nothrow()).exitCode !== 0) throw new Error("could not start the gateway");
	if (!(await waitHealth())) {
		throw new Error("The gateway didn't start within 60 seconds. Show its logs with: docker logs switchboard");
	}
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
		err(`the gateway rejected the bundle (HTTP ${res.status}) ${detail}`.trim());
		return false;
	} catch (e) {
		err(`could not reach the gateway: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** Wait for the phone to deliver the sealed bundle, by either the phone's LAN POST or a bundle the
 * user pastes here. The gateway writes transport.json the moment it installs a bundle, so that file
 * appearing is the success signal. Returns "installed" once it lands, or "back" if the user quits. */
async function waitForInstall(): Promise<"installed" | "back"> {
	console.log("\nWaiting for your phone to deliver the connection bundle...");
	for (;;) {
		// Give the phone's LAN delivery a few seconds to land before prompting, so the common case
		// needs no keypress.
		for (let i = 0; i < 5; i++) {
			if (await Bun.file(TRANSPORT_FILE_HOST).exists()) return "installed";
			await Bun.sleep(1000);
		}
		console.log("\n  Still waiting. The gateway connects on its own once your phone delivers.");
		console.log("    Enter) Check again");
		console.log("    p) Paste the bundle here instead");
		console.log("    b) Back");
		const choice = ask("  >").toLowerCase();
		if (choice === "b") return "back";
		if (choice === "p") {
			const bundle = ask("Paste the bundle, then press Enter:");
			if (bundle && (await postPastedBundle(bundle))) return "installed";
		}
	}
}

/** Render + display the gateway's admit payload, then offer to continue, save it to a file, or back
 * out. `render` prints the artifact on screen; `save` writes it to a temp file (tracked for cleanup)
 * and returns the path. Returns "continue" or "back". */
async function presentArtifact(
	heading: string,
	saveLabel: string,
	render: () => void,
	save: () => Promise<string>,
): Promise<"continue" | "back"> {
	render();
	for (;;) {
		console.log(`\n  ${heading}`);
		console.log("    1) Continue - wait for the phone, then connect");
		console.log(`    2) ${saveLabel}`);
		console.log("    b) Back");
		const choice = ask("  >").toLowerCase();
		if (choice === "1") return "continue";
		if (choice === "b") return "back";
		if (choice === "2") {
			try {
				const saved = await save();
				note(`Saved: ${saved}  (open it on this machine, then scan or copy it to your phone)`);
			} catch (e) {
				err(e instanceof Error ? e.message : String(e));
			}
		} else {
			err("Enter 1, 2, or b.");
		}
	}
}

/** Enroll THIS machine as a gateway, the same flow whether it is the first or the Nth. Names the
 * gateway, arms it for enrollment, shows its admit payload (as a QR or as JSON to copy), then waits
 * for the phone to deliver the connection bundle and restarts the gateway to connect. Any saved
 * artifact is wiped on success, on back-out, and on ^C. */
async function setupGateway(): Promise<void> {
	// The phone enrolls a gateway against a network it already owns, so the network must exist first.
	if (!(await envGet("FEDERATION_DOMAIN_ID"))) {
		console.log("Set up your network first - run option 2 (Evie Admin Provision).");
		return;
	}

	// The gateway is named by this machine's hostname; a pre-set GATEWAY_ID overrides it for
	// duplicate hostnames, so there is no name prompt.
	const id = (await envGet("GATEWAY_ID")) || (await gatewayHostname());
	await envSet("GATEWAY_ID", id);
	await $`chmod 600 .env`.quiet().nothrow();

	// An already-enrolled gateway has a delivered transport; re-enrolling disconnects it until a new
	// bundle arrives, so confirm before re-arming.
	if (await Bun.file(TRANSPORT_FILE_HOST).exists()) {
		if (
			!confirm(
				`Gateway "${id}" is already enrolled. Re-enroll it? It disconnects until you deliver a new bundle.`,
			)
		)
			return;
	}

	await armGateway();
	const payload = await readAdmitPayload();

	try {
		for (;;) {
			console.log(`\nGateway "${id}" is ready to enroll. Choose how to send it to your phone:`);
			console.log("  1) Enroll with QR Code");
			console.log("  2) Enroll with JSON Copy-pasta");
			console.log("  b) Back");
			const choice = ask(">").toLowerCase();

			let action: "continue" | "back";
			if (choice === "1") {
				action = await presentArtifact(
					"Scan this QR in your phone's Add Gateway screen.",
					"Save the QR as an image instead",
					() => {
						const { ansi, modules } = renderQrTerminal(payload);
						process.stdout.write(ansi);
						console.error(`${modules}x${modules} modules, needs ~${modules + 4} terminal columns`);
					},
					async () => {
						const { gif } = renderQrImageGif(payload);
						await Bun.write(GW_QR_GIF, gif);
						await $`chmod 600 ${GW_QR_GIF}`.quiet().nothrow();
						trackTemp(GW_QR_GIF);
						return GW_QR_GIF;
					},
				);
			} else if (choice === "2") {
				const pretty = JSON.stringify(JSON.parse(payload), null, 2);
				action = await presentArtifact(
					"Copy this JSON into your phone's Add Gateway screen.",
					"Save the JSON to a file instead",
					() => {
						console.log();
						console.log(pretty);
					},
					async () => {
						await Bun.write(GW_JSON_FILE, pretty);
						await $`chmod 600 ${GW_JSON_FILE}`.quiet().nothrow();
						trackTemp(GW_JSON_FILE);
						return GW_JSON_FILE;
					},
				);
			} else if (choice === "b") {
				return;
			} else {
				err("Enter 1, 2, or b.");
				continue;
			}

			if (action === "back") continue;

			// Continue: wait for the bundle (LAN delivery or a paste), then connect.
			if ((await waitForInstall()) === "installed") {
				await connectGateway();
				console.log();
				note(`Gateway "${id}" is connected.`);
				return;
			}
		}
	} finally {
		cleanupTemps();
	}
}

/** Wipe this machine's gateway setup (.env + volumes/gateway) back to nothing. */
async function purgeGateway(): Promise<void> {
	console.log("Wipes .env + volumes/gateway (keypair, admissions, mailboxes).");
	console.log("Re-configuring mints a new keypair, so the owner Console must re-admit this Gateway.");
	if (!confirm("Purge everything?")) return;
	// Drop this Gateway's admission from evie's Domain first (the admission stores the SANITIZED
	// slug, so use it not the raw env), then erase the local state.
	const domain = await envGet("FEDERATION_DOMAIN_ID");
	const gw = sanitizeGatewayId((await envGet("GATEWAY_ID")) || (await gatewayHostname()));
	await evieDelete((fed) => removeGatewayAdmission(fed, domain, gw));
	await dc("down", "--remove-orphans").quiet().nothrow();
	await wipeState();
	await $`rm -f .env`.quiet().nothrow();
	console.log("Purged. Run Configure to set it up fresh.");
}

////////////////////////////////
//  Provision steps (each throws on failure; the menu catches per-op, the top level exits)

/** Apply the console-bridge + gateway-bridge k8s objects and ensure CONSOLE_BRIDGE_TOKEN is set so
 * evie's ConsoleBridgeServer starts on 20004. Idempotent. */
async function cutover(): Promise<void> {
	note("Applying cluster objects (console + gateway bridges)...");
	for (const yaml of [BRIDGE_YAML, GATEWAY_BRIDGE_YAML]) {
		const r = await kStdin(await Bun.file(yaml).text(), "apply", "-f", "-")
			.quiet()
			.nothrow();
		if (r.exitCode !== 0) throw new Error(`kubectl apply ${yaml} failed`);
	}
	if ((await k("get", "secret", "console-bridge-app-token").quiet().nothrow()).exitCode !== 0) {
		// Reuse the old phone-bridge token if present so an already-pasted app token stays valid;
		// otherwise mint a fresh one.
		let tok = await kGetB64(
			"get",
			"secret",
			"phone-bridge-app-token",
			"-o",
			"jsonpath={.data.ANDROID_BRIDGE_TOKEN}",
		);
		if (!tok) tok = (await $`openssl rand -hex 32`.text()).trim();
		// Applied as YAML on stdin so the token never hits argv; a non-zero exit (an AlreadyExists race) is harmless.
		await applySecret("console-bridge-app-token", { CONSOLE_BRIDGE_TOKEN: tok });
		note("Minted the console bridge token.");
	}
	// A non-zero exit is tolerated (e.g. an AlreadyExists race); a genuinely unwired token surfaces
	// downstream at verify().
	await k("set", "env", EVIE_DEPLOY, "--from=secret/console-bridge-app-token").quiet().nothrow();
	note("Waiting for evie to restart...");
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled");
	}
}

/** Read evie's live federation.json, waiting for the pod to publish it. On a clean slate the
 * Secret was purged and evie re-creates it on boot, which can lag the rollout readiness. */
async function readEvieFed(): Promise<string> {
	let evieFed = "";
	for (let i = 0; i < 30; i++) {
		const b64 = (await k("get", "secret", FED_SECRET, "-o", "jsonpath={.data.federation\\.json}").quiet().nothrow())
			.text()
			.trim();
		if (b64) {
			evieFed = Buffer.from(b64, "base64").toString();
			break;
		}
		if (i === 0) note("Waiting for evie to publish its federation Secret...");
		await Bun.sleep(2000);
	}
	if (!evieFed) throw new Error("could not read evie federation Secret (is evie federation up?)");
	return evieFed;
}

/** Pre-stage the admin Domain as a PENDING tenant (fresh setup): an display name + a one-time
 * invite nonce, NO owner root. The admin's phone first-roots it on scan at its silently-generated
 * owner key (the same root-on-connect path a friend takes). Writes evie's federation Secret directly
 * (the trusted host bootstrap has Secret access, so it pre-stages the admin Domain without an admin
 * signature - unlike the phone's admin-signed provision_tenant for FRIEND tenants). Returns the
 * minted invite nonce so the caller emits it in the blob's `pendingTenant`. */
async function stageAdminPending(evieFed: string, adminDomainId: string): Promise<{ nonce: string }> {
	// The display name (the friendly network label): from the environment for a scripted run, else
	// prompted (D3). It is the same label the admin would type when hosting a friend.
	let displayName = (process.env.SB_DISPLAY_NAME ?? "").trim();
	if (!displayName) {
		if (!process.stdin.isTTY) {
			throw new Error("display name required (set SB_DISPLAY_NAME, or run interactively)");
		}
		console.log("Name your network (the label friends see, e.g. Nyaarium).");
		displayName = ask("Display name:");
	}
	if (!displayName) throw new Error("an display name is required");

	// The one-time invite nonce the friend echoes verbatim in its first_root frame. STANDARD base64
	// (not base64url): the wire `nonce` field is a b64Field ([A-Za-z0-9+/]={0,2}), and a base64url
	// nonce carrying -/_ would fail that schema parse. 18 random bytes match evie's mint.
	const nonce = randomBytes(18).toString("base64");
	const { federationJson } = pendingAdminDomain(
		evieFed,
		adminDomainId,
		displayName,
		nonce,
		Date.now(),
		INVITE_TTL_MS,
	);

	// Server-side apply: evie's pod created this Secret via the API (no kubectl last-applied
	// annotation), so a client-side apply warns on the first write after each purge. SSA ignores
	// that annotation, and --force-conflicts takes the field back from evie to write cleanly.
	if (!(await applySecret(FED_SECRET, { "federation.json": JSON.stringify(federationJson) }, true))) {
		throw new Error("writing federation Secret failed");
	}
	note(`Network "${displayName}" pre-staged (pending your phone's first scan).`);

	// Restart evie so it reads the pending state and serves it to the first-rooting console.
	await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled after pre-staging");
	}
	return { nonce };
}

/** Pull the console-bridge cluster creds into a TRANSPORT-ONLY provisioning blob (no identity, no
 * Gateway keys - the Console owns those). Also packs the gateway-bridge creds so the Console can
 * seal a bootstrap bundle for a creds-less Gateway it admits. `pendingTenant` is set only for a
 * fresh pending admin Domain (the admin domainId + the minted invite nonce), so the app first-roots
 * on scan; omitted for a re-provision of an already-rooted Domain (just provisions the console). */
async function emitBlob(pendingTenant?: { domainId: string; nonce: string }): Promise<void> {
	const { saToken, caPem } = await readSaCreds("console-bridge-proxy-token");
	if (!saToken || !caPem)
		throw new Error(
			"console-bridge SA token not populated yet - re-run provision-admin-domain.sh in a few seconds",
		);
	const appToken = await kGetB64(
		"get",
		"secret",
		"console-bridge-app-token",
		"-o",
		"jsonpath={.data.CONSOLE_BRIDGE_TOKEN}",
	);
	const apiUrl = await clusterApiUrl();

	const { saToken: swSa, caPem: swCa } = await readSaCreds("gateway-bridge-proxy-token");
	// The GatewayTransport shape (the gateway fills namespace/service/port defaults when it installs
	// the bundle). Absent when the gateway-bridge SA is not yet populated. Handed to the local Gateway
	// as bootstrap-transport.json, NOT carried in the blob: the Console fetches it via the
	// get_gateway_transport op when enrolling a creds-less Gateway, so a QR-sized blob fits. The
	// gateway-bridge auth is the SA token over the API service-proxy plus the owner-signed admission;
	// there is no bridge bearer to carry.
	const bootstrapTransport = swSa && swCa ? JSON.stringify({ apiUrl, saToken: swSa, caPem: swCa }) : undefined;
	if (bootstrapTransport && !(await writeGatewayFile(`${FED_DIR_IN}/bootstrap-transport.json`, bootstrapTransport))) {
		note("warning: could not write bootstrap-transport.json into the Gateway");
	}

	// writeProvisioningBlob VALIDATES against the shared ProvisioningSchema before writing, so a
	// field drift fails loudly here, not silently on the device.
	// NOTE: sttsUrl/sttsKey are NOT emitted. Voice creds are device-owned now (entered in the app's
	// Voice settings, persisted on the phone), so a re-provision never wipes voice; do not re-add them.
	await writeProvisioningBlob(
		{ apiUrl, caPem, saToken, appToken, namespace: NS, service: SERVICE, port: PORT, pendingTenant },
		BLOB_FILE,
	);
	await $`chmod 600 ${BLOB_FILE}`.quiet().nothrow();
	note(`Blob written: ${BLOB_FILE}`);
}

/** Write the local Gateway's service-proxy transport.json into its federation dir, so the gateway
 * reaches evie through the apiserver (off kubectl port-forward) on its next restart. */
async function writeGatewayTransport(): Promise<void> {
	const { saToken, caPem } = await readSaCreds("gateway-bridge-proxy-token");
	if (!saToken || !caPem)
		throw new Error(
			"gateway-bridge SA token not populated yet - re-run provision-admin-domain.sh in a few seconds",
		);
	const apiUrl = await clusterApiUrl();
	const transport = JSON.stringify({
		apiUrl,
		namespace: NS,
		saToken,
		caPem,
		service: "evie-bridge",
		port: 20001,
	});
	if (!(await writeGatewayFile(`${FED_DIR_IN}/transport.json`, transport))) {
		throw new Error("writing gateway transport.json failed");
	}
	note("Gateway transport written (applies on its next restart).");
}

/** Health-probe the full service-proxy -> bridge path with the emitted creds. Uses an AUTHENTICATED
 * POST /ingest (NOT a GET: the bridge answers GET 200 BEFORE the app-token gate), served locally at
 * evie so it isolates bridge+creds from gateway connectivity. Bearer tokens ride a 0600 curl -K
 * config, never argv. */
async function verify(): Promise<void> {
	if (!(await Bun.file(BLOB_FILE).exists()))
		throw new Error(`no blob at ${BLOB_FILE} - run provision-admin-domain.sh first`);
	const blob = jparse<{ apiUrl?: string; saToken?: string; appToken?: string; caPem?: string }>(
		await Bun.file(BLOB_FILE).text(),
	);
	if (!blob) throw new Error(`could not read blob ${BLOB_FILE}`);
	const apiUrl = blob.apiUrl ?? "";
	// Unpredictable names: the cfg holds the bearer tokens, so a guessable path would let a local
	// attacker pre-seed a symlink and capture them.
	const rnd = crypto.randomUUID();
	const ca = `/tmp/sb-verify-${rnd}-ca.pem`;
	const cfg = `/tmp/sb-verify-${rnd}-cfg.conf`;
	await Bun.write(ca, blob.caPem ?? "");
	await Bun.write(
		cfg,
		`header = "Authorization: Bearer ${blob.saToken ?? ""}"\nheader = "X-Console-Bridge-Token: Bearer ${blob.appToken ?? ""}"\n`,
	);
	await $`chmod 600 ${cfg}`.quiet().nothrow();
	const url = `${apiUrl}/api/v1/namespaces/${NS}/services/${SERVICE}:${PORT}/proxy/ingest`;
	const body = '{"conversationId":"provision-verify","lines":["provision-admin-domain.sh --verify auth probe"]}';
	try {
		// ConsoleBridge binds 20004 a few seconds AFTER the evie pod reports ready, so the proxy
		// returns 503 briefly after a (re)start. 401/404 are terminal - fail fast.
		let code = "000";
		let curlErr = "";
		for (let i = 0; i < 15; i++) {
			const r =
				await $`curl -s --cacert ${ca} -K ${cfg} -X POST -H ${"Content-Type: application/json"} --data ${body} -o /dev/null -w ${"%{http_code}"} ${url}`
					.quiet()
					.nothrow();
			code = r.text().trim();
			curlErr = r.stderr.toString().trim();
			if (code === "200") break;
			if (code === "401") {
				throw new Error(
					"VERIFY: app token REJECTED (HTTP 401) - the CONSOLE_BRIDGE_TOKEN in the blob does not match evie's. Re-run provision-admin-domain.sh",
				);
			}
			if (code === "404") {
				throw new Error(
					"VERIFY: bridge not found (HTTP 404) - console-bridge Service/objects not applied. Re-run provision-admin-domain.sh",
				);
			}
			await Bun.sleep(3000);
		}
		if (code !== "200") {
			const detail = curlErr ? ` (${curlErr})` : "";
			throw new Error(
				`VERIFY: bridge probe returned HTTP ${code} after retries${detail} (bridge still starting / creds) - re-run --verify shortly, or provision-admin-domain.sh`,
			);
		}
		note(
			"VERIFY: console bridge reachable + app token accepted (authenticated POST 200) - ready to import the blob",
		);
	} finally {
		await $`rm -f ${ca} ${cfg}`.quiet().nothrow();
	}
}

////////////////////////////////
//  QR menu

/** The blob, validated to fit a single QR. The gateway-bridge transport creds (the bulky half of
 * the old blob) are now fetched on demand via the get_gateway_transport op, not bundled, so the
 * blob sits well under a QR's ~2.9 KB ceiling. This guards against a future field pushing it over
 * with a clear error instead of qrcode-generator's raw overflow. */
function qrPayload(blobText: string): string {
	if (!fitsInQr(blobText)) {
		throw new Error(`the blob is ${blobText.length} bytes - too large for a QR; use paste or file import`);
	}
	return blobText;
}

/** Render the blob's QR in this terminal (wide - a full QR runs ~170+ modules). */
async function showQrTerminal(): Promise<void> {
	const blob = await Bun.file(BLOB_FILE)
		.text()
		.catch(() => "");
	if (!blob) throw new Error("could not render the QR (is the blob present?)");
	const { ansi, modules, ec } = renderQrTerminal(qrPayload(blob));
	process.stdout.write(ansi);
	console.error(`${modules}x${modules} modules, EC=${ec}, needs ~${modules + 4} terminal columns`);
}

/** Save the blob's QR as a 0600 GIF. Camera-friendly at any size. Returns the path. */
async function saveQrImage(): Promise<string> {
	const blob = await Bun.file(BLOB_FILE)
		.text()
		.catch(() => "");
	if (!blob) throw new Error("could not read the blob (is it present?)");
	const { gif } = renderQrImageGif(qrPayload(blob));
	await Bun.write(QR_GIF, gif);
	await $`chmod 600 ${QR_GIF}`.quiet().nothrow();
	return QR_GIF;
}

/** Post-setup dial menu: show the enrollment QR in the terminal, or save it as an image. Quitting
 * deletes a saved QR (the only enrollment-process file left behind); the 0600 blob stays. */
async function qrMenu(): Promise<void> {
	let saved = "";
	for (;;) {
		console.log(`\n  Enrollment QR  (encodes ${BLOB_FILE})`);
		console.log("    1) Display the QR in this terminal (wide)");
		console.log(`    2) Save the QR as an image -> ${QR_GIF}`);
		console.log(saved ? "    q) Delete the saved QR and quit" : "    q) Quit");
		const choice = ask("  >");
		if (choice === "1") {
			console.log();
			try {
				await showQrTerminal();
			} catch (e) {
				err(e instanceof Error ? e.message : String(e));
			}
			console.log();
		} else if (choice === "2") {
			try {
				saved = await saveQrImage();
				note(`saved: ${saved}  (open it and scan, or send it to the phone)`);
			} catch (e) {
				err(e instanceof Error ? e.message : String(e));
				saved = "";
			}
		} else if (choice === "" || choice.toLowerCase() === "q") {
			if (saved) {
				await $`rm -f ${saved}`.quiet().nothrow();
				note(`deleted saved QR: ${saved}`);
			}
			note(`Done. The blob remains at ${BLOB_FILE} (0600) for re-display via --qr.`);
			return;
		} else {
			err(`unknown option: '${choice}' (use 1, 2, or q)`);
		}
	}
}

////////////////////////////////
//  Top-level operations

/** Apply a purge mutation to evie's federation Secret in place and restart evie, best-effort. Reads
 * the live Secret, runs `mutate` over its federation.json, server-side applies the result, and rolls
 * evie. A no-op when no admin Domain id is set; failures are swallowed so the local wipe always
 * proceeds (a purge must not stall on an unreachable cluster). */
async function evieDelete(mutate: (fedJson: string) => string): Promise<void> {
	const domain = await envGet("FEDERATION_DOMAIN_ID");
	if (!domain) return;
	try {
		const fed = await readEvieFed();
		await applySecret(FED_SECRET, { "federation.json": mutate(fed) }, true);
		await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	} catch {}
}

/** The fresh-vs-reprovision state machine. After the cluster cutover it reads evie's admin Domain
 * slice: a FRESH (absent / unrooted) admin Domain is pre-staged as a PENDING tenant (display name + a
 * one-time invite nonce) and the blob carries `pendingTenant` so the admin's phone first-roots on
 * scan at its silent owner key; an already-ROOTED admin Domain skips staging and emits the blob ONLY,
 * preserving the existing display name. Then it verifies the bridge path either way. */
async function provision(): Promise<void> {
	await cutover();
	const evieFed = await readEvieFed();
	// The admin Domain id: a random hex id, minted on the first provision and pinned in the
	// gateway env. A re-provision reuses it; a fresh setup mints one and writes it back so the gateway
	// resolves the same Domain on restart.
	const existing = await envGet("FEDERATION_DOMAIN_ID");
	const adminDomainId = existing || sanitizeDomainId(randomBytes(8).toString("hex"));
	const adminDomain = readAdminDomain(evieFed, adminDomainId);

	let pendingTenant: { domainId: string; nonce: string } | undefined;
	if (adminDomain.rooted) {
		// Re-provision: the admin Domain is already rooted at the phone's owner key. Nothing to stage;
		// just refresh the transport creds.
		note(
			adminDomain.displayName
				? `Network "${adminDomain.displayName}" already rooted - re-provisioning.`
				: "Admin Domain already rooted - re-provisioning.",
		);
	} else {
		// Fresh setup: pre-stage the pending admin Domain and carry its invite nonce into the blob.
		const { nonce } = await stageAdminPending(evieFed, adminDomainId);
		pendingTenant = { domainId: adminDomainId, nonce };
		await envSet("FEDERATION_DOMAIN_ID", adminDomainId);
	}

	await emitBlob(pendingTenant);
	await verify();
	console.log();
	note(`Setup complete. Blob: ${BLOB_FILE}`);
}

/** Clean break: wipe the Console federation across all three places it lives. The gateway keypair
 * (identity.json) stays so the Gateway id is stable; only the mirrored allowlist goes. */
async function purgeFederation(): Promise<void> {
	console.log("Clean break - wipes the Console federation: evie's owner key + admissions, this");
	console.log(`Gateway's mirrored allowlist (keypair kept), and the host blob under ${SECRETS_DIR}.`);
	console.log("Everyone re-enrolls afterward.");
	if (!confirm("Purge everything?")) {
		note("Cancelled.");
		return;
	}

	// Drop only THIS Domain from evie's Secret so a hosted friend tenant survives (the old
	// whole-Secret delete took them down too).
	const domain = await envGet("FEDERATION_DOMAIN_ID");
	await evieDelete((fed) => removeDomain(fed, domain));
	note("evie: owner + admissions wiped, restarting.");

	await dx("rm", "-f", `${FED_DIR_IN}/federation-allowlist.json`).quiet().nothrow();
	note("Gateway: allowlist wiped (keypair kept; restart it to re-sync).");

	await $`rm -f ${OWNER_ID_FILE} ${BLOB_FILE} ${QR_GIF}`.quiet().nothrow();
	note("Host: blob + identity removed.");

	console.log();
	note("Done. Run Provision to set up fresh (it pre-stages the admin Domain; your phone roots it on scan).");
}

/** Top dial menu (the default, interactive run): the single bootstrap for the gateway and the
 * Console, grouped by what each option does. A first-time admin runs option 2 to set up the network,
 * then option 1 to enroll this machine as a gateway. */
async function topMenu(): Promise<void> {
	const ops: Record<string, () => Promise<void>> = {
		"1": setupGateway,
		"2": async () => {
			await provision();
			await qrMenu();
		},
		"9": purgeGateway,
		"0": purgeFederation,
	};
	const host = await gatewayHostname();
	for (;;) {
		console.log(`\n\u{1F365} Switchboard - Setup on ${host}\n`);
		console.log("Gateway:");
		console.log("  1) Setup Gateway        - Enroll this machine as a gateway and (re)show its QR\n");
		console.log("Admin:");
		console.log("  2) Evie Admin Provision - First-time setup of your Evie network\n");
		console.log("Purge:");
		console.log("  9) Purge Gateway        - Remove this gateway and erase its data");
		console.log("  0) Purge Federation     - Delete your whole network and erase everything");
		console.log("  q) Quit");
		const choice = ask(">").toLowerCase();
		if (choice === "" || choice === "q") return;
		const op = ops[choice];
		if (!op) {
			err("Enter 1, 2, 9, 0, or q.");
			continue;
		}
		// A failed operation drops back to the menu so the admin can retry instead of crashing the tool.
		try {
			await op();
		} catch (e) {
			err(e instanceof Error ? e.message : String(e));
		}
	}
}

////////////////////////////////
//  Entry

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "";
	switch (arg) {
		case "": {
			await ensureContainer();
			// write_gateway_transport is intentionally NOT in the Provision chain: it commits the
			// local Gateway to the service-proxy WS, and if WS-over-proxy does not work on this
			// cluster the Gateway could not connect. Validate that path first, then --gateway-transport.
			if (process.stdin.isTTY) {
				await topMenu();
			} else {
				await provision();
				note(`Import ${BLOB_FILE} into the app (paste or --qr).`);
			}
			break;
		}
		case "--qr": {
			if (!(await Bun.file(BLOB_FILE).exists()))
				die(`no blob at ${BLOB_FILE} - run provision-admin-domain.sh first`);
			await qrMenu();
			break;
		}
		case "--gateway-transport": {
			await ensureContainer();
			await writeGatewayTransport();
			break;
		}
		case "--verify": {
			await ensureContainer();
			await verify();
			break;
		}
		case "--help":
			console.log(USAGE);
			break;
		default:
			err(`unknown option: ${arg}`);
			console.log(USAGE);
			process.exit(1);
	}
}

// Every file this script writes carries key material or cluster creds; umask 077 makes them
// 0600/0700 from birth (the explicit chmod 600 stay as belt-and-suspenders).
process.umask(0o077);
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
