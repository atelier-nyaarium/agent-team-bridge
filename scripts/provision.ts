// Admin setup - the single bootstrap for this machine's gateway and the owner's Console. It
// configures + enrolls the gateway, roots the owner's own Domain, and emits the bridge blob the
// owner's Console imports. Driven by provision-admin-domain.sh, a thin launcher that execs this.
//
//   (no args)            interactive menu: configure/enroll the gateway, provision the admin Domain
//                        (cutover + pre-stage + emit the transport blob), re-show the QR, or purge.
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
import { $ } from "bun";
import { sanitizeDomainId } from "../src/shared/domain-id.js";
import { pendingAdminDomain, readAdminDomain } from "./bootstrap-domain.js";
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
	menu,
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

// The one-time invite lifetime for a freshly-staged pending admin Domain. Matches evie's
// DEFAULT_INVITE_TTL_MS (~1 day) so the admin has time to scan + connect; evie sweeps an
// unredeemed pending tenant at issuedAt + ttlMs.
const INVITE_TTL_MS = 86_400_000;

const USAGE = [
	"Admin setup - the SINGLE bootstrap for this gateway and the Android Console.",
	"",
	"  ./provision-admin-domain.sh              menu: configure/enroll the gateway, provision, QR, purge (non-TTY runs Provision direct)",
	"  ./provision-admin-domain.sh --gateway-transport  move the local Gateway onto the service-proxy WS",
	"  ./provision-admin-domain.sh --qr                 re-open the enrollment-QR menu for the current blob",
	"  ./provision-admin-domain.sh --verify             health-probe the bridge",
	"  ./provision-admin-domain.sh --help",
].join("\n");

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
 * federation dir (by provision-admin-domain.sh / enrollment). Absent = standalone, no mesh. */
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

/** The local Gateway's Domain id, ensured present in .env before any container bring-up. The gateway
 * fails closed at boot when FEDERATION_DOMAIN_ID is unset, so a fresh setup mints one (a random hex
 * id) and writes it back. Returns the existing id when already set. */
async function ensureDomainId(): Promise<string> {
	const id = await envGet("FEDERATION_DOMAIN_ID");
	if (id) return id;
	const minted = sanitizeDomainId(randomBytes(8).toString("hex"));
	await envSet("FEDERATION_DOMAIN_ID", minted);
	return minted;
}

////////////////////////////////
//  Gateway operations (throw on failure; the menu catches per-op, the top level exits)

/** Prompt for GATEWAY_ID / owner key, write .env, then rebuild + start the gateway. A gateway joins
 * the mesh once a service-proxy transport has been delivered (enrollment); when one is present, show
 * its admit-gateway QR. */
async function configureGateway(): Promise<void> {
	const host = await gatewayHostname();
	const curId = await envGet("GATEWAY_ID");
	const curOwner = await envGet("FEDERATION_OWNER_SIGN_PUB");

	// The Gateway is named by the device hostname; a pre-set GATEWAY_ID is the escape hatch for
	// duplicate hostnames, so there is no nickname prompt.
	const id = curId || host;

	// FEDERATION_OWNER_SIGN_PUB pins which owner this Gateway trusts (the base64 key from the app's
	// owner screen) so a compromised evie cannot re-root it. Optional: blank = trust on first enroll.
	const ownerKey =
		ask(`Owner key (optional, blank = trust on first enroll)${curOwner ? " [keep]" : ""}:`) || curOwner;

	await ensureDomainId();
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

/** Creds-less LAN enrollment: arm a one-time nonce + advertise this host's LAN address, start the
 * gateway so it prints the admit-gateway QR, and wait for the admin Console to deliver a sealed
 * bundle. After delivery, a plain start connects via the installed service-proxy transport. */
async function enrollGateway(): Promise<void> {
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

/** Wipe this machine's gateway setup (.env + volumes/gateway) back to nothing. */
async function purgeGateway(): Promise<void> {
	console.log("Wipes .env + volumes/gateway (keypair, admissions, mailboxes).");
	console.log("Re-configuring mints a new keypair, so the owner Console must re-admit this Gateway.");
	if (!confirm("Purge everything?")) return;
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
		// just refresh the transport creds. Sanity-check a gateway owner pin against the rooted key so
		// a mismatched pin (which would make the gateway silently drop this Domain's allowlist) aborts
		// with the exact remediation instead of failing invisibly downstream.
		const pin = (await dx("printenv", "FEDERATION_OWNER_SIGN_PUB").quiet().nothrow()).text().trim();
		if (pin && adminDomain.ownerSignPub && pin !== adminDomain.ownerSignPub) {
			throw new Error(
				`the gateway pins a DIFFERENT Domain owner key than the rooted admin Domain:\n` +
					`  gateway FEDERATION_OWNER_SIGN_PUB = ${pin}\n` +
					`  rooted admin Domain owner          = ${adminDomain.ownerSignPub}\n` +
					`  Set FEDERATION_OWNER_SIGN_PUB=${adminDomain.ownerSignPub} on the gateway (or unset it), restart it, then re-run provision-admin-domain.sh.`,
			);
		}
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

	await k("delete", "secret", FED_SECRET, "--ignore-not-found").quiet().nothrow();
	await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	note("evie: owner + admissions wiped, restarting.");

	await dx("rm", "-f", `${FED_DIR_IN}/federation-allowlist.json`).quiet().nothrow();
	note("Gateway: allowlist wiped (keypair kept; restart it to re-sync).");

	await $`rm -f ${OWNER_ID_FILE} ${BLOB_FILE} ${QR_GIF}`.quiet().nothrow();
	note("Host: blob + identity removed.");

	console.log();
	note("Done. Run Provision to set up fresh (it pre-stages the admin Domain; your phone roots it on scan).");
}

/** Top dial menu (the default, interactive run): the single bootstrap for the gateway and the Console. */
async function topMenu(): Promise<void> {
	await menu(`Switchboard - Admin setup on ${await gatewayHostname()}`, [
		{
			key: "1",
			label: "Configure gateway - GATEWAY_ID + owner key, mint the Domain id, rebuild + start",
			run: configureGateway,
		},
		{
			key: "2",
			label: "Provision         - root your Domain + emit the Console blob, then the QR",
			run: async () => {
				await provision();
				await qrMenu();
			},
		},
		{
			key: "3",
			label: "Enroll gateway    - creds-less LAN enroll (join an existing Domain)",
			run: enrollGateway,
		},
		{
			key: "4",
			label: "Enrollment QR     - re-show the Console enrollment QR",
			run: async () => {
				if (await Bun.file(BLOB_FILE).exists()) await qrMenu();
				else err("No blob yet - run Provision first.");
			},
		},
		{
			key: "5",
			label: "Purge gateway     - wipe this gateway's .env + local data",
			run: purgeGateway,
		},
		{
			key: "0",
			label: "Purge federation  - clean break: evie owner + admissions, allowlist, host blob",
			run: purgeFederation,
		},
	]);
}

////////////////////////////////
//  Entry

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "";
	switch (arg) {
		case "": {
			await ensureDomainId();
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
