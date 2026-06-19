// Console setup - the SINGLE bootstrap for the Android Console. Driven by provision-console.sh,
// a thin launcher that execs this.
//
//   --setup              interactive menu: Provision (cutover + root the Domain at the CONSOLE
//                        owner key + emit the transport blob) or Purge (clean-break wipe).
//                        Non-TTY runs Provision direct.
//   --gateway-transport  move the local Gateway off port-forward onto the service-proxy WS (run
//                        AFTER validating WS-over-proxy on this cluster).
//   --qr                 re-open the enrollment-QR menu for the current blob.
//   --verify             health-probe the bridge + report what is / is not set up.
//   --help
//
// Phone-anchored trust: the Domain ROOT private key is generated on the Console and never reaches
// the host. This script (on the trusted host with cluster access) roots evie's Domain at the owner
// PUBLIC keys the operator reads from the app, then emits a transport-ONLY blob (cluster creds; no
// identity, no Gateway keys). The Console generates its own identity, admits itself, and admits
// each Gateway afterward. Mirrors the Gateway's start-gateway.sh --setup ergonomics.

import { $ } from "bun";
import { bootstrapDomain } from "./bootstrap-domain.js";
import {
	applySecret,
	ask,
	confirm,
	die,
	dx,
	ensureContainer,
	envGet,
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

const USAGE = [
	"Console setup - the SINGLE bootstrap for the Android Console.",
	"",
	"  ./provision-console.sh --setup              menu: Provision or Purge (non-TTY runs Provision direct)",
	"  ./provision-console.sh --gateway-transport  move the local Gateway onto the service-proxy WS",
	"  ./provision-console.sh --qr                 re-open the enrollment-QR menu for the current blob",
	"  ./provision-console.sh --verify             health-probe the bridge",
	"  ./provision-console.sh --help",
].join("\n");

////////////////////////////////
//  kubectl read helpers (the typed Secret reads + apply live in lib/host.ts)

/** The cluster's apiserver URL (config view ignores -n, so k() is fine here). */
async function clusterApiUrl(): Promise<string> {
	const r = await k("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}").quiet().nothrow();
	return r.text().trim();
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

/** Root the Domain at the CONSOLE owner's public keys (phone-anchored trust), writing evie's
 * federation Secret directly. The owner private key never reaches the host: the operator reads the
 * pubkeys from the app. The crypto is bootstrapDomain() so the rooted owner verifies byte-for-byte
 * on the gateway + app. */
async function bootstrap(): Promise<void> {
	note("Rooting the Domain at your owner key...");
	// On a clean slate the Secret was purged; evie re-creates it on boot, which can lag the rollout
	// readiness. Wait for federation.json to appear before reading it.
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

	// The Console owner pubkeys: from the environment for a scripted run, else prompted. The
	// operator reads both from the app's Owner setup screen and confirms the fingerprint.
	let ownerSign = process.env.SB_OWNER_SIGN_PUB ?? "";
	let ownerBox = process.env.SB_OWNER_BOX_PUB ?? "";
	if (!ownerSign || !ownerBox) {
		if (!process.stdin.isTTY) {
			throw new Error("owner pubkeys required (set SB_OWNER_SIGN_PUB + SB_OWNER_BOX_PUB, or run interactively)");
		}
		console.log("In the app: Owner setup -> Copy owner keys, then paste here.");
		const ownerJson = ask("Owner keys:");
		if (ownerJson.includes('"signPub"')) {
			const parsed = jparse<{ signPub?: string; boxPub?: string }>(ownerJson);
			ownerSign = parsed?.signPub ?? "";
			ownerBox = parsed?.boxPub ?? "";
		} else {
			// Fallback: a bare signing key was pasted (older app or manual entry).
			ownerSign = ownerJson;
			ownerBox = ask("Owner box key:");
		}
	}
	if (!ownerSign || !ownerBox) throw new Error("owner keys are required (use the app's 'Copy owner keys' button)");

	const { ownerSignPub: ownerPub, federationJson } = bootstrapDomain(evieFed, ownerSign, ownerBox);

	// If the gateway PINS an owner key (untrusted-evie mode) it refuses any allowlist not rooted at
	// that key, so a mismatched pin silently drops this Domain. Abort with the exact remediation.
	const pin = (await dx("printenv", "FEDERATION_OWNER_SIGN_PUB").quiet().nothrow()).text().trim();
	if (pin && pin !== ownerPub) {
		throw new Error(
			`the gateway pins a DIFFERENT Domain owner key than this root:\n` +
				`  gateway FEDERATION_OWNER_SIGN_PUB = ${pin}\n` +
				`  this Domain root                  = ${ownerPub}\n` +
				`  Set FEDERATION_OWNER_SIGN_PUB=${ownerPub} on the gateway (or unset it), restart it, then re-run --setup.`,
		);
	}

	// Server-side apply: evie's pod created this Secret via the API (no kubectl last-applied
	// annotation), so a client-side apply warns on the first write after each purge. SSA ignores
	// that annotation, and --force-conflicts takes the field back from evie to root cleanly.
	if (!(await applySecret(FED_SECRET, { "federation.json": JSON.stringify(federationJson) }, true))) {
		throw new Error("writing federation Secret failed");
	}
	note("Domain rooted at your owner key.");

	// Restart evie so it reads the rooted state. The Console then submits its own admission and
	// admits this Gateway afterward (no host-side admit).
	await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled after bootstrap");
	}
}

/** Pull the console-bridge cluster creds into a TRANSPORT-ONLY provisioning blob (no identity, no
 * Gateway keys - the Console owns those). Also packs the gateway-bridge creds so the Console can
 * seal a bootstrap bundle for a creds-less Gateway it admits. */
async function emitBlob(): Promise<void> {
	const { saToken, caPem } = await readSaCreds("console-bridge-proxy-token");
	if (!saToken || !caPem)
		throw new Error("console-bridge SA token not populated yet - re-run --setup in a few seconds");
	const appToken = await kGetB64(
		"get",
		"secret",
		"console-bridge-app-token",
		"-o",
		"jsonpath={.data.CONSOLE_BRIDGE_TOKEN}",
	);
	const apiUrl = await clusterApiUrl();

	const { saToken: swSa, caPem: swCa } = await readSaCreds("gateway-bridge-proxy-token");
	const swApp = await envGet("BRIDGE_TOKEN");
	// The 4-field GatewayTransport shape (the gateway fills namespace/service/port defaults when it
	// installs the bundle). Absent when the gateway-bridge SA is not yet populated. Handed to the
	// home Gateway as bootstrap-transport.json, NOT carried in the blob: the Console fetches it via
	// the get_gateway_transport op when enrolling a creds-less Gateway, so a QR-sized blob fits and
	// the gateway-bridge token never persists on the device.
	const bootstrapTransport =
		swSa && swCa ? JSON.stringify({ apiUrl, saToken: swSa, caPem: swCa, appToken: swApp || "" }) : undefined;
	if (bootstrapTransport && !(await writeGatewayFile(`${FED_DIR_IN}/bootstrap-transport.json`, bootstrapTransport))) {
		note("warning: could not write bootstrap-transport.json into the Gateway");
	}

	// writeProvisioningBlob VALIDATES against the shared ProvisioningSchema before writing, so a
	// field drift fails loudly here, not silently on the device.
	await writeProvisioningBlob(
		{ apiUrl, caPem, saToken, appToken, namespace: NS, service: SERVICE, port: PORT },
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
		throw new Error("gateway-bridge SA token not populated yet - re-run --setup in a few seconds");
	const appToken = await envGet("BRIDGE_TOKEN");
	const apiUrl = await clusterApiUrl();
	const transport = JSON.stringify({
		apiUrl,
		namespace: NS,
		saToken,
		caPem,
		appToken: appToken || "",
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
	if (!(await Bun.file(BLOB_FILE).exists())) throw new Error(`no blob at ${BLOB_FILE} - run --setup first`);
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
	const body = '{"conversationId":"provision-verify","lines":["provision-console.sh --verify auth probe"]}';
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
					"VERIFY: app token REJECTED (HTTP 401) - the CONSOLE_BRIDGE_TOKEN in the blob does not match evie's. Re-run --setup",
				);
			}
			if (code === "404") {
				throw new Error(
					"VERIFY: bridge not found (HTTP 404) - console-bridge Service/objects not applied. Re-run --setup",
				);
			}
			await Bun.sleep(3000);
		}
		if (code !== "200") {
			const detail = curlErr ? ` (${curlErr})` : "";
			throw new Error(
				`VERIFY: bridge probe returned HTTP ${code} after retries${detail} (bridge still starting / creds) - re-run --verify shortly, or --setup`,
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

/** Cutover the cluster objects, root the Domain at the app's owner key, emit the transport blob,
 * verify the bridge path. */
async function provision(): Promise<void> {
	await cutover();
	await bootstrap();
	await emitBlob();
	await verify();
	console.log();
	note(`Setup complete. Blob: ${BLOB_FILE}`);
}

/** Clean break: wipe the Console federation across all three places it lives. The gateway keypair
 * (identity.json) stays so the Gateway id is stable; only the mirrored allowlist goes. */
async function purge(): Promise<void> {
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
	note("Done. Run Provision with the app's owner keys to set up fresh.");
}

/** Top dial menu (interactive --setup), mirroring start-gateway.sh's --setup. */
async function topMenu(): Promise<void> {
	await menu("Switchboard - Console setup", [
		{
			key: "1",
			label: "Provision - Root the Domain + emit the blob",
			run: async () => {
				await provision();
				await qrMenu();
			},
		},
		{
			key: "2",
			label: "Enroll QR - Show the enrollment QR",
			run: async () => {
				if (await Bun.file(BLOB_FILE).exists()) await qrMenu();
				else err("No blob yet - run Provision first.");
			},
		},
		{ key: "0", label: "Purge     - Clean break (re-enroll everything)", run: purge },
	]);
}

////////////////////////////////
//  Entry

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "";
	switch (arg) {
		case "--setup": {
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
			if (!(await Bun.file(BLOB_FILE).exists())) die(`no blob at ${BLOB_FILE} - run --setup first`);
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
		case "":
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
