// Console setup - the SINGLE bootstrap for the Android Console. Driven by provision-console.sh,
// which is now a thin launcher that execs this.
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
	ask,
	CONTAINER,
	confirm,
	die,
	dx,
	ensureContainer,
	err,
	jparse,
	k,
	kStdin,
	menu,
	NS,
	note,
} from "./lib/host.js";
import { renderQrImageGif, renderQrTerminal } from "./render-provisioning-qr.js";
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
//  kubectl read helpers

/** A base64-decoded kubectl jsonpath read; empty string when the secret/field is absent. */
async function kGetB64(...args: string[]): Promise<string> {
	const r = await k(...args)
		.quiet()
		.nothrow();
	const v = r.text().trim();
	return v ? Buffer.from(v, "base64").toString() : "";
}

/** The cluster's apiserver URL (config view ignores -n, so k() is fine here). */
async function clusterApiUrl(): Promise<string> {
	const r = await k("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}").quiet().nothrow();
	return r.text().trim();
}

/** Read one KEY=value from the local .env (the host BRIDGE_TOKEN lives there). */
async function readEnvValue(key: string): Promise<string> {
	const env = await Bun.file(".env")
		.text()
		.catch(() => "");
	const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
	return line ? line.slice(key.length + 1).trim() : "";
}

////////////////////////////////
//  Provision steps (each throws on failure; the menu catches per-op, the top level exits)

/** Apply the console-bridge + gateway-bridge k8s objects and ensure CONSOLE_BRIDGE_TOKEN is set so
 * evie's ConsoleBridgeServer starts on 20004. Idempotent. */
async function cutover(): Promise<void> {
	note("cutover: applying console-bridge + gateway-bridge objects (Services + SAs + Roles + tokens)");
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
		// The token rides the Secret YAML on stdin (base64), never argv, like bootstrap's Secret write.
		const tokYaml = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: console-bridge-app-token\n  namespace: ${NS}\ntype: Opaque\ndata:\n  CONSOLE_BRIDGE_TOKEN: ${Buffer.from(tok).toString("base64")}\n`;
		await kStdin(tokYaml, "apply", "-f", "-").quiet().nothrow();
		note("cutover: minted console-bridge-app-token");
	}
	// Tolerate a non-zero exit (e.g. an AlreadyExists race) the way the bash did; a genuinely
	// unwired token surfaces downstream at verify().
	await k("set", "env", EVIE_DEPLOY, "--from=secret/console-bridge-app-token").quiet().nothrow();
	note("cutover: CONSOLE_BRIDGE_TOKEN wired into evie; waiting for rollout");
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled");
	}
}

/** Root the Domain at the CONSOLE owner's public keys (phone-anchored trust), writing evie's
 * federation Secret directly. The owner private key never reaches the host: the operator reads the
 * pubkeys from the app. The crypto is bootstrapDomain() so the rooted owner verifies byte-for-byte
 * on the gateway + app. */
async function bootstrap(): Promise<void> {
	note("bootstrap: setting the owner key as the mesh authority");
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
		if (i === 0) note("bootstrap: waiting for evie to publish the federation Secret...");
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
		console.log("Open the Console app -> Owner setup, tap 'Copy owner keys', and paste it here:");
		const ownerJson = ask("  owner keys (JSON):");
		if (ownerJson.includes('"signPub"')) {
			const parsed = jparse<{ signPub?: string; boxPub?: string }>(ownerJson);
			ownerSign = parsed?.signPub ?? "";
			ownerBox = parsed?.boxPub ?? "";
		} else {
			// Fallback: a bare signing key was pasted (older app or manual entry).
			ownerSign = ownerJson;
			ownerBox = ask("  owner box key (base64):");
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
	const b64 = Buffer.from(JSON.stringify(federationJson)).toString("base64");
	const secretYaml = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${FED_SECRET}\n  namespace: ${NS}\ntype: Opaque\ndata:\n  federation.json: ${b64}\n`;
	if (
		(await kStdin(secretYaml, "apply", "--server-side", "--force-conflicts", "-f", "-").quiet().nothrow())
			.exitCode !== 0
	) {
		throw new Error("writing federation Secret failed");
	}
	note(`bootstrap: owner set to ${ownerPub}`);

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
	const saToken = await kGetB64("get", "secret", "console-bridge-proxy-token", "-o", "jsonpath={.data.token}");
	const caPem = await kGetB64("get", "secret", "console-bridge-proxy-token", "-o", "jsonpath={.data.ca\\.crt}");
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

	const swSa = await kGetB64("get", "secret", "gateway-bridge-proxy-token", "-o", "jsonpath={.data.token}");
	const swCa = await kGetB64("get", "secret", "gateway-bridge-proxy-token", "-o", "jsonpath={.data.ca\\.crt}");
	const swApp = await readEnvValue("BRIDGE_TOKEN");
	// The 4-field GatewayTransport shape (the gateway fills namespace/service/port defaults when it
	// installs the bundle). Omitted when the gateway-bridge SA is not yet populated.
	const gatewayTransport =
		swSa && swCa ? JSON.stringify({ apiUrl, saToken: swSa, caPem: swCa, appToken: swApp || "" }) : undefined;

	// writeProvisioningBlob VALIDATES against the shared ProvisioningSchema before writing, so a
	// field drift fails loudly here, not silently on the device.
	await writeProvisioningBlob(
		{ apiUrl, caPem, saToken, appToken, namespace: NS, service: SERVICE, port: PORT, gatewayTransport },
		BLOB_FILE,
	);
	await $`chmod 600 ${BLOB_FILE}`.quiet().nothrow();
	note(`blob written: ${BLOB_FILE}  (console-bridge cluster creds; the Console owns its identity)`);
}

/** Write the local Gateway's service-proxy transport.json into its federation dir, so the gateway
 * reaches evie through the apiserver (off kubectl port-forward) on its next restart. */
async function writeGatewayTransport(): Promise<void> {
	const saToken = await kGetB64("get", "secret", "gateway-bridge-proxy-token", "-o", "jsonpath={.data.token}");
	const caPem = await kGetB64("get", "secret", "gateway-bridge-proxy-token", "-o", "jsonpath={.data.ca\\.crt}");
	if (!saToken || !caPem)
		throw new Error("gateway-bridge SA token not populated yet - re-run --setup in a few seconds");
	const appToken = await readEnvValue("BRIDGE_TOKEN");
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
	const sh =
		"mkdir -p /app/log/federation && cat > /app/log/federation/transport.json && chmod 600 /app/log/federation/transport.json";
	const r = await $`docker exec -i ${CONTAINER} sh -c ${sh} < ${Buffer.from(transport)}`.quiet().nothrow();
	if (r.exitCode !== 0) throw new Error("writing gateway transport.json failed");
	note("gateway transport written: the gateway uses the service-proxy after its next restart");
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
	// Unpredictable names (like the bash mktemp): the cfg holds the bearer tokens, so a guessable
	// path would let a local attacker pre-seed a symlink and capture them.
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

/** Render the blob as a QR in this terminal (wide - the blob is ~2.7KB, ~177 modules). */
async function showQrTerminal(): Promise<void> {
	const text = await Bun.file(BLOB_FILE)
		.text()
		.catch(() => "");
	if (!text) throw new Error("could not render the QR (is the blob present?)");
	process.stdout.write(renderQrTerminal(text).ansi);
}

/** Save the blob's QR as a 0600 GIF and return the path. Camera-friendly at any size. */
async function saveQrImage(): Promise<string> {
	const { gif } = renderQrImageGif(await Bun.file(BLOB_FILE).text());
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
			} catch {
				err("could not save the QR image");
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
	console.log("Purge is a CLEAN BREAK - it wipes the Console federation back to nothing:");
	console.log(`  - evie's owner key + every admission (the ${FED_SECRET} Secret); evie restarts with no owner`);
	console.log(`  - this Gateway's mirrored allowlist (${FED_DIR_IN}/federation-allowlist.json; keypair kept)`);
	console.log(`  - the host's owner identity + transport blob under ${SECRETS_DIR}`);
	console.log("Every Gateway and Console must re-enroll afterward.");
	if (!confirm("Purge everything?")) {
		note("purge cancelled");
		return;
	}

	await k("delete", "secret", FED_SECRET, "--ignore-not-found").quiet().nothrow();
	await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	note("evie: federation Secret deleted, evie restarting with no owner");

	await dx("rm", "-f", `${FED_DIR_IN}/federation-allowlist.json`).quiet().nothrow();
	note("Gateway: mirrored allowlist wiped (keypair kept; restart the gateway to re-sync clean)");

	await $`rm -f ${OWNER_ID_FILE} ${BLOB_FILE} ${QR_GIF}`.quiet().nothrow();
	note("host: owner identity + blob removed");

	console.log();
	note("Clean break done. Run Provision (option 1) with the app's owner keys to set up fresh.");
}

/** Top dial menu (interactive --setup), mirroring start-gateway.sh's --setup. */
async function topMenu(): Promise<void> {
	await menu("Switchboard - Evie authority setup", [
		{
			key: "1",
			label: "Provision - Set the owner from the app key and emit the blob",
			run: async () => {
				await provision();
				await qrMenu();
			},
		},
		{
			key: "2",
			label: "Enroll QR - Show the enrollment QR for the current blob",
			run: async () => {
				if (await Bun.file(BLOB_FILE).exists()) await qrMenu();
				else err("no blob yet - run Provision (1) first");
			},
		},
		{ key: "0", label: "Purge     - Erase identity, allowlist, blob, and k8s secret", run: purge },
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
				note(`Import ${BLOB_FILE} into the Console app (paste, or scan its QR via --qr). No enroll step.`);
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
