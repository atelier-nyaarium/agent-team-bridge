// The Evie Admin Provision path: apply the console-bridge cluster objects, pre-stage or refresh the
// admin Domain in evie's federation Secret, and emit the transport-only blob the Console imports.
// Driven by setup.ts's top dial menu (option 2); the purge side lives in setup-purge.ts.

import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { $ } from "bun";
import { sanitizeDomainId } from "../src/shared/domain-id.js";
import { pendingAdminDomain, readAdminDomain } from "./bootstrap-domain.js";
import {
	applySecret,
	ask,
	clearAdminKubeconfig,
	ensureAdminKubernetes,
	envGet,
	envSet,
	jparse,
	k,
	kGetB64,
	kStdin,
	NS,
	note,
	readSaCreds,
	secureFile,
	writeGatewayFile,
} from "./lib/host.js";
import {
	BLOB_FILE,
	BRIDGE_YAML,
	EVIE_DEPLOY,
	FED_DIR_IN,
	FED_SECRET,
	GATEWAY_BRIDGE_YAML,
	INVITE_TTL_MS,
	PORT,
	SERVICE,
} from "./setup-constants.js";
import { writeProvisioningBlob } from "./write-provisioning-blob.js";

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
async function applyBridgeManifests(): Promise<void> {
	note("Applying cluster objects");
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
		if (!tok) tok = randomBytes(32).toString("hex");
		// Applied as YAML on stdin so the token never hits argv; a non-zero exit (an AlreadyExists race) is harmless.
		await applySecret("console-bridge-app-token", { CONSOLE_BRIDGE_TOKEN: tok });
		note("Minted console bridge token");
	}
	// A non-zero exit is tolerated (e.g. an AlreadyExists race); a genuinely unwired token surfaces
	// downstream at verify().
	await k("set", "env", EVIE_DEPLOY, "--from=secret/console-bridge-app-token").quiet().nothrow();
	note("Waiting for evie");
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled");
	}
}

/** Read evie's live federation.json, waiting for the pod to publish it. On a clean slate the
 * Secret was purged and evie re-creates it on boot, which can lag the rollout readiness. Also the
 * read half of setup-purge.ts's evieDelete. */
export async function readEvieFed(): Promise<string> {
	let evieFed = "";
	for (let i = 0; i < 30; i++) {
		const b64 = (await k("get", "secret", FED_SECRET, "-o", "jsonpath={.data.federation\\.json}").quiet().nothrow())
			.text()
			.trim();
		if (b64) {
			evieFed = Buffer.from(b64, "base64").toString();
			break;
		}
		if (i === 0) note("Waiting for evie federation Secret");
		await Bun.sleep(2000);
	}
	if (!evieFed) throw new Error("could not read evie federation Secret (is evie federation up?)");
	return evieFed;
}

/** Pre-stage the admin Domain as a PENDING tenant (display name + one-time invite nonce, no owner
 * root); the admin's phone first-roots it on scan at its silent owner key. Writes evie's federation
 * Secret directly: the trusted host bootstrap has Secret access, so it stages without an admin
 * signature, unlike the phone's admin-signed provision_tenant for friend tenants. Returns the nonce. */
async function stageAdminPending(evieFed: string, adminDomainId: string): Promise<{ nonce: string }> {
	// The owner's display name: from the environment for a scripted run, else prompted.
	let displayName = (process.env.SB_DISPLAY_NAME ?? "").trim();
	if (!displayName) {
		if (!process.stdin.isTTY) {
			throw new Error("display name required (set SB_DISPLAY_NAME, or run interactively)");
		}
		displayName = ask("Your user display name:");
	}
	if (!displayName) throw new Error("a display name is required");

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
	note("Pre-staged.");

	// Restart evie so it reads the pending state and serves it to the first-rooting console.
	await k("rollout", "restart", EVIE_DEPLOY).quiet().nothrow();
	if ((await k("rollout", "status", EVIE_DEPLOY, "--timeout=120s").quiet().nothrow()).exitCode !== 0) {
		throw new Error("evie rollout stalled after pre-staging");
	}
	return { nonce };
}

/** Pull the console-bridge cluster creds into a TRANSPORT-ONLY provisioning blob (no identity, no
 * Gateway keys - the Console owns those). `pendingTenant` is set only for a fresh pending admin
 * Domain (the admin domainId + the minted invite nonce) so the app first-roots on scan; omitted for
 * a re-provision of an already-rooted Domain. */
async function emitBlob(pendingTenant?: { domainId: string; nonce: string }): Promise<void> {
	const { saToken, caPem } = await readSaCreds("console-bridge-proxy-token");
	if (!saToken || !caPem) throw new Error("console-bridge SA token not ready yet - re-run in a few seconds");
	const appToken = await kGetB64(
		"get",
		"secret",
		"console-bridge-app-token",
		"-o",
		"jsonpath={.data.CONSOLE_BRIDGE_TOKEN}",
	);
	const apiUrl = await clusterApiUrl();

	// The gateway-bridge transport (the proxy SA token + CA) is NOT in the blob. The Console pulls it
	// from evie on demand (a signed TRANSPORT_REQUEST_V1 proof) when enrolling a creds-less Gateway,
	// so a QR-sized blob fits and evie holds the one copy.

	// writeProvisioningBlob VALIDATES against the shared ProvisioningSchema before writing, so a
	// field drift fails loudly here, not silently on the device.
	// sttsUrl/sttsKey are NOT emitted: voice creds are device-owned (entered in the app's Voice
	// settings, persisted on the phone), so a re-provision never wipes voice. Do not re-add them.
	await writeProvisioningBlob(
		{ apiUrl, caPem, saToken, appToken, namespace: NS, service: SERVICE, port: PORT, pendingTenant },
		BLOB_FILE,
	);
	secureFile(BLOB_FILE);
	note(`Blob: ${BLOB_FILE}`);
}

/** Write the local Gateway's service-proxy transport.json into its federation dir, so the gateway
 * reaches evie through the apiserver (off kubectl port-forward) on its next restart. */
export async function writeGatewayTransport(): Promise<void> {
	const { saToken, caPem } = await readSaCreds("gateway-bridge-proxy-token");
	if (!saToken || !caPem) throw new Error("gateway-bridge SA token not ready yet - re-run in a few seconds");
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
	note("Gateway transport written");
}

/** Health-probe the full service-proxy -> bridge path with the emitted creds. Uses an AUTHENTICATED
 * POST /ingest (NOT a GET: the bridge answers GET 200 BEFORE the app-token gate), served locally at
 * evie so it isolates bridge+creds from gateway connectivity. Bearer tokens ride a 0600 curl -K
 * config, never argv. */
export async function verify(): Promise<void> {
	if (!(await Bun.file(BLOB_FILE).exists())) throw new Error(`no blob at ${BLOB_FILE} - run setup.sh first`);
	const blob = jparse<{ apiUrl?: string; saToken?: string; appToken?: string; caPem?: string }>(
		await Bun.file(BLOB_FILE).text(),
	);
	if (!blob) throw new Error(`could not read blob ${BLOB_FILE}`);
	const apiUrl = blob.apiUrl ?? "";
	// Unpredictable names: the cfg holds the bearer tokens, so a guessable path would let a local
	// attacker pre-seed a symlink and capture them.
	const rnd = crypto.randomUUID();
	const ca = path.join(os.tmpdir(), `sb-verify-${rnd}-ca.pem`);
	const cfg = path.join(os.tmpdir(), `sb-verify-${rnd}-cfg.conf`);
	await Bun.write(ca, blob.caPem ?? "");
	await Bun.write(
		cfg,
		`header = "Authorization: Bearer ${blob.saToken ?? ""}"\nheader = "X-Console-Bridge-Token: Bearer ${blob.appToken ?? ""}"\n`,
	);
	secureFile(cfg);
	// curl's null sink differs per platform (POSIX /dev/null, Windows NUL).
	const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
	const url = `${apiUrl}/api/v1/namespaces/${NS}/services/${SERVICE}:${PORT}/proxy/ingest`;
	const body = '{"conversationId":"provision-verify","lines":["setup.sh --verify auth probe"]}';
	try {
		// ConsoleBridge binds 20004 a few seconds AFTER the evie pod reports ready, so the proxy
		// returns 503 briefly after a (re)start. 401/404 are terminal - fail fast.
		let code = "000";
		let curlErr = "";
		for (let i = 0; i < 15; i++) {
			const r =
				await $`curl -s --cacert ${ca} -K ${cfg} -X POST -H ${"Content-Type: application/json"} --data ${body} -o ${nullDev} -w ${"%{http_code}"} ${url}`
					.quiet()
					.nothrow();
			code = r.text().trim();
			curlErr = r.stderr.toString().trim();
			if (code === "200") break;
			if (code === "401") {
				throw new Error("VERIFY: app token rejected (401) - blob token != evie's. Re-run provision.");
			}
			if (code === "404") {
				throw new Error("VERIFY: bridge not found (404) - console-bridge not applied. Re-run provision.");
			}
			await Bun.sleep(3000);
		}
		if (code !== "200") {
			const detail = curlErr ? ` (${curlErr})` : "";
			throw new Error(`VERIFY: bridge probe HTTP ${code}${detail} - re-run --verify shortly`);
		}
		note("VERIFY: bridge reachable, token accepted");
	} finally {
		await $`rm -f ${ca} ${cfg}`.quiet().nothrow();
	}
}

/** The fresh-vs-reprovision state machine. After applying the bridge manifests it reads evie's admin Domain
 * slice: a fresh (absent/unrooted) Domain is pre-staged as a PENDING tenant and the blob carries
 * `pendingTenant` so the phone first-roots on scan; an already-rooted Domain skips staging and emits
 * the blob only. Verifies the bridge path either way. */
export async function provision(): Promise<void> {
	// Admin-only: downstream Gateway enrollment never reads SWITCHBOARD_KUBECONFIG. The first
	// administrator adds its local kubeconfig path to .env before selecting this menu option.
	await ensureAdminKubernetes();
	try {
		await applyBridgeManifests();
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
			note("Already set up, re-provisioning.");
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
	} finally {
		await clearAdminKubeconfig();
	}
}
