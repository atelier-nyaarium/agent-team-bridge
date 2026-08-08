// Admin setup - the single bootstrap for this machine's gateway and the owner's Console. It
// configures + enrolls the gateway and emits the bridge blob the owner's Console imports. Driven by
// setup.sh, a thin launcher that execs this. The menu loop lives here; each dial option's logic is a
// sibling module: setup-gateway.ts (enroll), setup-provision.ts (Evie Admin Provision),
// setup-purge.ts (Purge Gateway / Purge Federation), setup-enrollment-ui.ts (the QR/JSON present
// flow), setup-board-guard.ts (the typed purge confirmation), setup-constants.ts (shared paths).
//
//   (no args)            interactive menu: set up this gateway, provision the admin Domain, or purge.
//                        Non-TTY runs Provision direct.
//   --gateway-transport  move the local Gateway off port-forward onto the service-proxy WS (run
//                        AFTER validating WS-over-proxy on this cluster).
//   --qr                 re-open the enrollment-QR menu for the current blob.
//   --verify             health-probe the bridge.
//   --help
//
// The Domain ROOT private key is generated on the Console and never reaches the host, so this script
// never holds, prompts for, or roots with the owner key. Provision branches on whether the admin
// Domain is already rooted in evie's federation Secret: a fresh (absent/unrooted) Domain is pre-staged
// as a PENDING tenant (display name + one-time invite nonce, no owner root) and the blob carries
// `pendingTenant` so the phone first-roots on scan; an already-rooted Domain skips staging and emits
// the blob only. The blob is transport-only (cluster creds; no identity, no Gateway keys).

import fs from "node:fs";
import { ask, clearAdminKubeconfig, die, ensureAdminKubernetes, err, note } from "./lib/host.js";
import { BLOB_FILE, SECRETS_DIR } from "./setup-constants.js";
import { qrMenu } from "./setup-enrollment-ui.js";
import { gatewayHostname, setupGateway } from "./setup-gateway.js";
import { provision, verify, writeGatewayTransport } from "./setup-provision.js";
import { purgeFederation, purgeGateway } from "./setup-purge.js";

////////////////////////////////
//  Constants

const USAGE = [
	"Admin setup - the SINGLE bootstrap for this gateway and the Android Console.",
	"",
	"  ./setup.sh              menu: set up the gateway, provision, purge (non-TTY runs Provision direct)",
	"  ./setup.sh --gateway-transport  move the local Gateway onto the service-proxy WS",
	"  ./setup.sh --qr                 re-open the enrollment-QR menu for the current blob",
	"  ./setup.sh --verify             health-probe the bridge",
	"  ./setup.sh --help",
].join("\n");

////////////////////////////////
//  Top dial menu

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
	const host = gatewayHostname();
	for (;;) {
		console.log(`\n\u{1F365} Switchboard - Setup on ${host}\n`);
		console.log("Gateway:");
		console.log("  1) Setup Gateway        - Enroll this machine as a gateway and (re)show its QR\n");
		console.log("Admin:");
		console.log("  2) Evie Admin Provision - First-time setup of your Evie network\n");
		console.log("     Before first use, add SWITCHBOARD_KUBECONFIG=/absolute/path/to/kubeconfig.yaml to .env\n");
		console.log("Purge:");
		console.log("  9) Purge Gateway        - Remove this gateway and erase its data");
		console.log("  0) Purge Federation     - Delete your whole Domain and erase everything\n");
		console.log("  q) Quit\n");
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
			// write_gateway_transport is intentionally NOT in the Provision chain: it commits the
			// local Gateway to the service-proxy WS, and if WS-over-proxy does not work on this
			// cluster the Gateway could not connect. Validate that path first, then --gateway-transport.
			if (process.stdin.isTTY) {
				await topMenu();
			} else {
				await provision();
				note(`Import ${BLOB_FILE} into the app.`);
			}
			break;
		}
		case "--qr": {
			if (!(await Bun.file(BLOB_FILE).exists())) die(`no blob at ${BLOB_FILE} - run setup.sh first`);
			await qrMenu();
			break;
		}
		case "--gateway-transport": {
			await ensureAdminKubernetes();
			try {
				await writeGatewayTransport();
			} finally {
				await clearAdminKubeconfig();
			}
			break;
		}
		case "--verify": {
			await ensureAdminKubernetes();
			try {
				await verify();
			} finally {
				await clearAdminKubeconfig();
			}
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

// Every file this script writes carries key material or cluster creds. On POSIX, umask 077 makes
// them 0600/0700 from birth and secureFile() reasserts it; Windows ignores the mode and the files
// inherit the user profile's ACL instead.
if (process.platform !== "win32") process.umask(0o077);
fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
