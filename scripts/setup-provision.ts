// The Admin Provision path: pre-stage or refresh the admin Domain in the Router's federation state,
// and emit the transport-only blob the Console imports. Driven by setup.ts's top dial menu (option
// 2); the purge side lives in setup-purge.ts.
//
// The Router IS the deployment, so there is nothing to apply and nothing to roll out: state is a
// file the Router owns, and a write to it is "stop, write, start" because the store is single-writer.

import { randomBytes } from "node:crypto";
import { sanitizeDomainId } from "../src/shared/domain-id.js";
import { pendingAdminDomain, readAdminDomain } from "./bootstrap-domain.js";
import { requireDocker } from "./lib/docker-probe.js";
import { ask, dcFederation, envGet, envSet, note, secureFile } from "./lib/host.js";
import {
	ensureRouterEnv,
	ROUTER_PORT,
	readPublicReach,
	routerHealth,
	shortFp,
	startRouter,
	writePublicReach,
} from "./lib/routerStart.js";
import { readRouterFed, routerRunning, writeRouterFed } from "./lib/routerState.js";
import { BLOB_FILE, INVITE_TTL_MS } from "./setup-constants.js";
import { verify } from "./setup-verify.js";
import { writeProvisioningBlob } from "./write-provisioning-blob.js";

////////////////////////////////
//  Router reach

/** The one thing setup asks about the Router: where it is reached from OUTSIDE. The LAN address is
 * detected and never asked. Empty host means LAN only and the port is not asked. Prefilled from
 * .env, so a re-run is enter, enter. */
async function askPublicReach(): Promise<{ publicHost: string; publicPort: number }> {
	const current = await readPublicReach();
	const hostAnswer = ask(`Public host [${current.publicHost || "none"}]:`);
	const publicHost = hostAnswer === "" ? current.publicHost : hostAnswer.toLowerCase() === "none" ? "" : hostAnswer;
	if (!publicHost) return { publicHost: "", publicPort: ROUTER_PORT };
	const portAnswer = ask(`Public port [${current.publicPort}]:`);
	const publicPort = portAnswer === "" ? current.publicPort : Number(portAnswer);
	if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
		throw new Error(`not a port: ${portAnswer}`);
	return { publicHost, publicPort };
}

/** Ask, write, and bring the Router up on the answer. A running Router whose reach did not move is
 * left alone entirely, not even handed to compose: recreating it drops every gateway for a few
 * seconds, and enter, enter should cost nothing. One whose reach moved is recreated on the image it
 * already runs; only a Router that is not up gets a build, since that is a fresh machine. Non-TTY
 * takes .env as it stands. */
async function ensureRouter(): Promise<void> {
	// Before the prompt, for the same reason Gateway Setup checks first: this ends in `compose up`.
	await requireDocker();
	const before = await readPublicReach();
	const bindBefore = await envGet("FEDERATION_BIND");
	const wasRunning = await routerRunning();
	if (process.stdin.isTTY) {
		const { publicHost, publicPort } = await askPublicReach();
		await writePublicReach(publicHost, publicPort);
	}
	const env = await ensureRouterEnv();
	const unchanged =
		env.publicHost === before.publicHost && env.publicPort === before.publicPort && env.lan === bindBefore;
	if (wasRunning && unchanged) {
		const health = await routerHealth(env.lan);
		if (health) {
			note(`Router running. Fingerprint ${shortFp(health.certFingerprint)}`);
			return;
		}
	}
	const health = await startRouter(env, { build: !wasRunning });
	note(`Router ${health.wasRunning ? "restarted" : "ready"}. Fingerprint ${shortFp(health.certFingerprint)}`);
}

////////////////////////////////
//  Router reads

/** The Router's federation state, waiting briefly for a first boot to mint it. A running Router
 * always has one, so an empty read past the wait is a READ failure, and it throws rather than
 * returning "". Returning "" would read as "no Domain yet", and the fresh branch would then stage a
 * pending Domain OVER a rooted one - which is what happened the first time this ran, stopped only
 * by the display-name prompt. */
async function readFed(): Promise<string> {
	for (let i = 0; i < 15; i++) {
		const fed = await readRouterFed();
		if (fed) return fed;
		if (i === 0) note("Waiting for the Router's federation state");
		await Bun.sleep(2000);
	}
	throw new Error(
		"could not read the Router's federation state (volumes/federation-data/federation.json) - refusing to guess whether a Domain exists",
	);
}

/** The address the blob names, and the leaf it pins. The fingerprint comes from the running Router's
 * /health so a blob can never carry a pin the Router does not actually present. The address is the
 * PUBLIC host and port when one is configured, else the LAN bind: a phone only needs one address it
 * can reach to learn every other from the Router's `reach` op, and the public one is the one that
 * works from anywhere once the port is forwarded. */
async function routerReach(): Promise<{ routerUrl: string; routerCertFp: string }> {
	const bind = await envGet("FEDERATION_BIND");
	if (!bind) throw new Error("no LAN bind in .env - run ./start-federation.sh");
	const health = await routerHealth(bind);
	if (!health)
		throw new Error(`the Router at ${bind}:${ROUTER_PORT} did not answer /health - run ./start-federation.sh`);
	const { publicHost, publicPort } = await readPublicReach();
	if (!publicHost)
		note("No public address: the setup code names the LAN address, so a phone must be on this network to scan it.");
	const routerUrl = publicHost ? `https://${publicHost}:${publicPort}` : `https://${bind}:${ROUTER_PORT}`;
	return { routerUrl, routerCertFp: health.certFingerprint };
}

////////////////////////////////
//  Steps

/** Pre-stage the admin Domain as a PENDING tenant (display name + one-time invite nonce, no owner
 * root); the admin's phone first-roots it on scan at its silent owner key. Writes the Router's state
 * directly: the trusted host bootstrap owns the file, so it stages without an admin signature, unlike
 * the phone's admin-signed provision_tenant for friend tenants. Returns the nonce. */
async function stageAdminPending(fed: string, adminDomainId: string): Promise<{ nonce: string }> {
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
	// nonce carrying -/_ would fail that schema parse. 18 random bytes match the Router's mint.
	const nonce = randomBytes(18).toString("base64");
	const { federationJson } = pendingAdminDomain(fed, adminDomainId, displayName, nonce, Date.now(), INVITE_TTL_MS);

	// The store is single-writer and the Router holds its own copy, so a write under a live one is
	// overwritten silently. Stop, write, start.
	const wasRunning = await routerRunning();
	if (wasRunning) await dcFederation("stop").quiet();
	try {
		await writeRouterFed(JSON.stringify(federationJson));
	} finally {
		if (wasRunning) await dcFederation("start").quiet();
	}
	note("Pre-staged.");
	return { nonce };
}

/** Emit the TRANSPORT-ONLY provisioning blob (no identity, no Gateway keys - the Console owns those).
 * `pendingTenant` is set only for a fresh pending admin Domain (the admin domainId + the minted
 * invite nonce) so the app first-roots on scan; omitted for a re-provision of an already-rooted Domain. */
async function emitBlob(pendingTenant?: { domainId: string; nonce: string }): Promise<void> {
	const appToken = await envGet("CONSOLE_BRIDGE_TOKEN");
	if (!appToken) throw new Error("CONSOLE_BRIDGE_TOKEN missing from .env - run ./start-federation.sh once first");
	const { routerUrl, routerCertFp } = await routerReach();

	// writeProvisioningBlob VALIDATES against the shared ProvisioningSchema before writing, so a
	// field drift fails loudly here, not silently on the device.
	// sttsUrl/sttsKey are NOT emitted: voice creds are device-owned (entered in the app's Voice
	// settings, persisted on the phone), so a re-provision never wipes voice. Do not re-add them.
	await writeProvisioningBlob({ routerUrl, routerCertFp, appToken, pendingTenant }, BLOB_FILE);
	secureFile(BLOB_FILE);
	note(`Setup code: ${BLOB_FILE}`);
}

////////////////////////////////
//  Entry

/** The fresh-vs-reprovision state machine. Asks the public reach and brings the Router up on it,
 * then reads the Router's admin Domain slice: a fresh (absent/unrooted) Domain is pre-staged as a
 * PENDING tenant and the blob carries `pendingTenant` so the phone first-roots on scan; an
 * already-rooted Domain skips staging and emits the blob only. Verifies the Router and this
 * Gateway's link to it either way. */
export async function provision(): Promise<void> {
	await ensureRouter();
	const fed = await readFed();
	// The admin Domain id: a random hex id, minted on the first provision and pinned in the gateway
	// env. A re-provision reuses it; a fresh setup mints one and writes it back so the gateway
	// resolves the same Domain on restart.
	const existing = await envGet("FEDERATION_DOMAIN_ID");
	const adminDomainId = existing || sanitizeDomainId(randomBytes(8).toString("hex"));
	const adminDomain = readAdminDomain(fed, adminDomainId);

	let pendingTenant: { domainId: string; nonce: string } | undefined;
	if (adminDomain.rooted) {
		// Re-provision: the admin Domain is already rooted at the phone's owner key. Nothing to stage;
		// just refresh the transport fields.
		note("Already set up, re-provisioning.");
	} else {
		// Fresh setup: pre-stage the pending admin Domain and carry its invite nonce into the blob.
		const { nonce } = await stageAdminPending(fed, adminDomainId);
		pendingTenant = { domainId: adminDomainId, nonce };
		await envSet("FEDERATION_DOMAIN_ID", adminDomainId);
	}

	await emitBlob(pendingTenant);
	await verify();
	console.log();
	note(`Setup complete. Setup code: ${BLOB_FILE}`);
	if (pendingTenant) note("Next: scan the setup code on your phone, then run 1) Gateway Setup.");
}
