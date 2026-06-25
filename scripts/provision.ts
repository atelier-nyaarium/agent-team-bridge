// Console setup - the SINGLE bootstrap for the Android Console. Driven by provision-console.sh,
// a thin launcher that execs this.
//
//   --setup              interactive menu: Provision (cutover + pre-stage the home Domain +
//                        emit the transport blob) or Purge (clean-break wipe). Non-TTY runs
//                        Provision direct.
//   --gateway-transport  move the local Gateway off port-forward onto the service-proxy WS (run
//                        AFTER validating WS-over-proxy on this cluster).
//   --qr                 re-open the enrollment-QR menu for the current blob.
//   --verify             health-probe the bridge + report what is / is not set up.
//   --help
//
// Phone-anchored trust: the Domain ROOT private key is generated SILENTLY on the Console and never
// reaches the host, so this script never holds, prompts for, or roots with the owner key. Provision
// is a fresh-vs-reprovision state machine keyed on whether the home Domain is already rooted in
// evie's federation Secret:
//   - FRESH (home absent / unrooted): the trusted host bootstrap (direct Secret access) pre-stages
//     the home Domain as a PENDING tenant - an operator name the operator types + a one-time invite
//     nonce, no owner root - and emits a transport-ONLY blob carrying `pendingTenant`. The operator's
//     phone reads it and first-roots the home Domain at its silent owner key, exactly like a friend.
//   - RE-PROVISION (home already rooted): skip staging; emit the blob only (no `pendingTenant`),
//     preserving the existing operator name.
// The blob is transport-only (cluster creds; no identity, no Gateway keys). The Console generates its
// own identity, admits itself, and admits each Gateway afterward. Mirrors start-gateway.sh --setup.

import { randomBytes } from "node:crypto";
import { $ } from "bun";
import { sanitizeDomainId } from "../src/shared/domain-id.js";
import { pendingHomeDomain, readHomeDomain } from "./bootstrap-domain.js";
import {
	applySecret,
	ask,
	confirm,
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

// The one-time invite lifetime for a freshly-staged pending home Domain. Matches evie's
// DEFAULT_INVITE_TTL_MS (~1 day) so the operator has time to scan + connect; evie sweeps an
// unredeemed pending tenant at issuedAt + ttlMs.
const INVITE_TTL_MS = 86_400_000;

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

/** Pre-stage the home Domain as a PENDING tenant (fresh setup): an operator name + a one-time
 * invite nonce, NO owner root. The operator's phone first-roots it on scan at its silently-generated
 * owner key (the same root-on-connect path a friend takes). Writes evie's federation Secret directly
 * (the trusted host bootstrap has Secret access, so it pre-stages the home Domain without an operator
 * signature - unlike the phone's operator-signed provision_tenant for FRIEND tenants). Returns the
 * minted invite nonce so the caller emits it in the blob's `pendingTenant`. */
async function stageHomePending(evieFed: string, homeDomainId: string): Promise<{ nonce: string }> {
	// The operator name (the friendly network label): from the environment for a scripted run, else
	// prompted (D3). It is the same label the operator would type when hosting a friend.
	let operatorName = (process.env.SB_OPERATOR_NAME ?? "").trim();
	if (!operatorName) {
		if (!process.stdin.isTTY) {
			throw new Error("operator name required (set SB_OPERATOR_NAME, or run interactively)");
		}
		console.log("Name your network (the label friends see, e.g. Nyaarium).");
		operatorName = ask("Operator name:");
	}
	if (!operatorName) throw new Error("an operator name is required");

	// The one-time invite nonce the friend echoes verbatim in its first_root frame. STANDARD base64
	// (not base64url): the wire `nonce` field is a b64Field ([A-Za-z0-9+/]={0,2}), and a base64url
	// nonce carrying -/_ would fail that schema parse. 18 random bytes match evie's mint.
	const nonce = randomBytes(18).toString("base64");
	const { federationJson } = pendingHomeDomain(evieFed, homeDomainId, operatorName, nonce, Date.now(), INVITE_TTL_MS);

	// Server-side apply: evie's pod created this Secret via the API (no kubectl last-applied
	// annotation), so a client-side apply warns on the first write after each purge. SSA ignores
	// that annotation, and --force-conflicts takes the field back from evie to write cleanly.
	if (!(await applySecret(FED_SECRET, { "federation.json": JSON.stringify(federationJson) }, true))) {
		throw new Error("writing federation Secret failed");
	}
	note(`Home network "${operatorName}" pre-staged (pending your phone's first scan).`);

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
 * fresh pending home Domain (the home domainId + the minted invite nonce), so the app first-roots
 * on scan; omitted for a re-provision of an already-rooted Domain (just provisions the console). */
async function emitBlob(pendingTenant?: { domainId: string; nonce: string }): Promise<void> {
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

/** The fresh-vs-reprovision state machine. After the cluster cutover it reads evie's home Domain
 * slice: a FRESH (absent / unrooted) home is pre-staged as a PENDING tenant (operator name + a
 * one-time invite nonce) and the blob carries `pendingTenant` so the operator's phone first-roots on
 * scan at its silent owner key; an already-ROOTED home skips staging and emits the blob ONLY,
 * preserving the existing operator name. Then it verifies the bridge path either way. */
async function provision(): Promise<void> {
	await cutover();
	const evieFed = await readEvieFed();
	// The operator's home Domain id: a random hex id, minted on the first provision and pinned in the
	// gateway env. A re-provision reuses it; a fresh setup mints one and writes it back so the gateway
	// resolves the same Domain on restart.
	const existing = await envGet("FEDERATION_DOMAIN_ID");
	const homeDomainId = existing || sanitizeDomainId(randomBytes(8).toString("hex"));
	const home = readHomeDomain(evieFed, homeDomainId);

	let pendingTenant: { domainId: string; nonce: string } | undefined;
	if (home.rooted) {
		// Re-provision: the home Domain is already rooted at the phone's owner key. Nothing to stage;
		// just refresh the transport creds. Sanity-check a gateway owner pin against the rooted key so
		// a mismatched pin (which would make the gateway silently drop this Domain's allowlist) aborts
		// with the exact remediation instead of failing invisibly downstream.
		const pin = (await dx("printenv", "FEDERATION_OWNER_SIGN_PUB").quiet().nothrow()).text().trim();
		if (pin && home.ownerSignPub && pin !== home.ownerSignPub) {
			throw new Error(
				`the gateway pins a DIFFERENT Domain owner key than the rooted home Domain:\n` +
					`  gateway FEDERATION_OWNER_SIGN_PUB = ${pin}\n` +
					`  rooted home Domain owner          = ${home.ownerSignPub}\n` +
					`  Set FEDERATION_OWNER_SIGN_PUB=${home.ownerSignPub} on the gateway (or unset it), restart it, then re-run --setup.`,
			);
		}
		note(
			home.operatorName
				? `Home network "${home.operatorName}" already rooted - re-provisioning.`
				: "Home Domain already rooted - re-provisioning.",
		);
	} else {
		// Fresh setup: pre-stage the pending home Domain and carry its invite nonce into the blob.
		const { nonce } = await stageHomePending(evieFed, homeDomainId);
		pendingTenant = { domainId: homeDomainId, nonce };
		await envSet("FEDERATION_DOMAIN_ID", homeDomainId);
	}

	await emitBlob(pendingTenant);
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
	note("Done. Run Provision to set up fresh (it pre-stages the home Domain; your phone roots it on scan).");
}

/** Top dial menu (interactive --setup), mirroring start-gateway.sh's --setup. */
async function topMenu(): Promise<void> {
	await menu("Switchboard - Console setup", [
		{
			key: "1",
			label: "Provision - Pre-stage the home Domain + emit the blob",
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
