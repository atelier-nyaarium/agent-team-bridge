// The two teardown paths off setup.ts's top dial menu: Purge Gateway (option 9, this machine only)
// and Purge Federation (option 0, the whole Domain). Both share the board-loss guard, the volume
// wipe, and the evie federation Secret mutation below.

import fs from "node:fs";
import { $ } from "bun";
import { sanitizeGatewayId } from "../src/shared/gateway-id.js";
import { removeDomain, removeGatewayAdmission } from "./bootstrap-domain.js";
import { applySecret, confirm, dc, dirExists, envGet, k } from "./lib/host.js";
import { confirmBoardLoss } from "./setup-board-guard.js";
import {
	BLOB_FILE,
	CONSOLE_JSON_FILE,
	EVIE_DEPLOY,
	FED_SECRET,
	GW_JSON_FILE,
	GW_QR_GIF,
	QR_GIF,
	SECRETS_DIR,
} from "./setup-constants.js";
import { gatewayHostname } from "./setup-gateway.js";
import { readEvieFed } from "./setup-provision.js";

////////////////////////////////
//  Purge primitives (throw on failure; the menu catches per-op, the top level exits)

/** Erase both gateway volumes: volumes/gateway-data (all durable state) and volumes/gateway (logs).
 * The gateway writes them as the in-container user, so a host-side rm is denied; a root container
 * with the same mount clears them. */
async function wipeState(): Promise<void> {
	for (const dir of ["volumes/gateway-data", "volumes/gateway"]) {
		if (!dirExists(dir)) continue;
		const mount = `${process.cwd()}/${dir}:/w`;
		const sh = "cd /w && rm -rf -- ..?* .[!.]* * 2>/dev/null; true";
		if ((await $`docker run --rm -u 0 -v ${mount} busybox sh -c ${sh}`.quiet().nothrow()).exitCode !== 0) {
			throw new Error(`could not erase ${dir} (is docker running?)`);
		}
	}
}

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

////////////////////////////////
//  Top-level operations

/** Wipe this machine's gateway setup (.env + both gateway volumes) back to nothing. */
export async function purgeGateway(): Promise<void> {
	console.log("Wipes .env + volumes/gateway-data + volumes/gateway.");
	if (!confirm("Purge everything?")) return;
	if (!(await confirmBoardLoss())) return;
	// Drop this Gateway's admission from evie's Domain first (the admission stores the SANITIZED
	// slug, so use it not the raw env), then erase the local state.
	const domain = await envGet("FEDERATION_DOMAIN_ID");
	const gw = sanitizeGatewayId((await envGet("GATEWAY_ID")) || gatewayHostname());
	await evieDelete((fed) => removeGatewayAdmission(fed, domain, gw));
	await dc("down", "--remove-orphans").quiet().nothrow();
	await wipeState();
	await $`rm -f .env ${GW_QR_GIF} ${GW_JSON_FILE}`.quiet().nothrow();
	console.log("Purged.");
}

/** Clean break: delete this owner's whole Domain from evie, then erase the local state with the
 * same full wipe as Purge gateway so a re-provision starts fresh. A hosted friend tenant survives. */
export async function purgeFederation(): Promise<void> {
	console.log("Wipes the network from evie, plus .env + both gateway volumes + the host blob.");
	if (!confirm("Purge everything?")) return;
	if (!(await confirmBoardLoss())) return;

	const domain = await envGet("FEDERATION_DOMAIN_ID");
	await evieDelete((fed) => removeDomain(fed, domain));
	await dc("down", "--remove-orphans").quiet().nothrow();
	await wipeState();
	await $`rm -f .env ${BLOB_FILE} ${QR_GIF} ${CONSOLE_JSON_FILE} ${GW_QR_GIF} ${GW_JSON_FILE}`.quiet().nothrow();
	// A non-recursive rmdir only succeeds on an empty dir, so this tidies the blob's home without
	// touching other secrets; a non-empty dir throws and is ignored.
	try {
		fs.rmdirSync(SECRETS_DIR);
	} catch {}
	console.log("Purged.");
}
