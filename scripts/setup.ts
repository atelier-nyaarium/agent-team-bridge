// Switchboard setup - the single bootstrap for this machine's Federation Router, its gateway, and the
// owner's Console. It asks the one thing it cannot detect (the public address), writes .env itself,
// starts the Router, enrolls the gateway and emits the setup code the Console scans. Driven by
// setup.sh, a thin launcher that execs this. The menu loop lives here; each dial option's logic is a
// sibling module: setup-status.ts (the header above the dial), setup-gateway.ts (Gateway Setup),
// setup-provision.ts (Router Setup), setup-purge.ts (Purge Gateway / Purge Federation),
// setup-enrollment-ui.ts (the QR/JSON present flow), setup-board-guard.ts (the typed purge
// confirmation), setup-constants.ts (shared paths).
//
// User-facing wording follows the APP's, since the same person reads both screens minutes apart:
// "Federation Router" is what its Settings calls the Router, and what the phone scans is a "setup
// code" there, never a blob. `provision` stays the internal name for the Router Setup path.
//
//   (no args)            interactive menu: Router Setup, Gateway Setup, or purge.
//                        Non-TTY runs Router Setup direct on .env as it stands.
//   --qr                 re-show the current setup code as a QR or JSON.
//   --verify             health-probe the Router and this Gateway's link to it.
//   --help
//
// The Domain ROOT private key is generated on the Console and never reaches the host, so this script
// never holds, prompts for, or roots with the owner key. Router Setup branches on whether the admin
// Domain is already rooted in the Router's federation state: a fresh (absent/unrooted) Domain is
// pre-staged as a PENDING tenant (display name + one-time invite nonce, no owner root) and the setup
// code carries `pendingTenant` so the phone first-roots on scan; an already-rooted Domain skips
// staging and emits the code only. It is transport-only (the Router's address, pin and app token; no
// identity, no Gateway keys).

import fs from "node:fs";
import { ask, die, err, note } from "./lib/host.js";
import { BLOB_FILE, SECRETS_DIR } from "./setup-constants.js";
import { qrMenu } from "./setup-enrollment-ui.js";
import { gatewayHostname, setupGateway } from "./setup-gateway.js";
import { provision } from "./setup-provision.js";
import { purgeFederation, purgeGateway } from "./setup-purge.js";
import { printSetupStatus, readSetupStatus } from "./setup-status.js";
import { verify } from "./setup-verify.js";

////////////////////////////////
//  Constants

const USAGE = [
	"Switchboard setup - the SINGLE bootstrap for this machine's Federation Router and gateway.",
	"",
	"  ./setup.sh          menu: Router Setup, Gateway Setup, purge (non-TTY runs Router Setup direct)",
	"  ./setup.sh --qr     re-show the current setup code as a QR or JSON",
	"  ./setup.sh --verify health-probe the Router and this Gateway's link to it",
	"  ./setup.sh --help",
].join("\n");

////////////////////////////////
//  Top dial menu

/** Top dial menu (the default, interactive run): the single bootstrap for the gateway and the
 * Console, grouped by what each option does. The header above the dial is read fresh on every draw,
 * and the option labels are chosen from the same state, so what an option WILL do is what it says.
 * A first-time admin runs option 2 to set up the network, then option 1 to enroll this machine. */
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
		const status = await readSetupStatus();
		console.log(`\n\u{1F365} Switchboard - Setup on ${host}\n`);
		printSetupStatus(status);
		// Wording matches the app's own, since these two screens are read by the same person minutes
		// apart: "Federation Router" is what Settings calls it, and what the phone scans is a "setup
		// code" there, never a blob.
		console.log("\nGateway:");
		console.log(
			status.gatewayEnrolled
				? "  1) Gateway Setup        - Re-enroll this machine and show its Add Gateway code\n"
				: "  1) Gateway Setup        - Enroll this machine and show its Add Gateway code\n",
		);
		console.log("Federation Router:");
		console.log(
			status.domain === "rooted"
				? "  2) Router Setup         - Change the public address, show a new setup code\n"
				: "  2) Router Setup         - Set the public address and make a setup code\n",
		);
		console.log("Purge:");
		console.log("  9) Purge Gateway        - Remove this machine's gateway and erase its data (the Router stays)");
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
		case "--verify": {
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

// Every file this script writes carries key material or cluster creds. On POSIX, umask 077 makes
// them 0600/0700 from birth and secureFile() reasserts it; Windows ignores the mode and the files
// inherit the user profile's ACL instead.
if (process.platform !== "win32") process.umask(0o077);
fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
