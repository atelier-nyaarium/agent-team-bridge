// The "send this to your phone" presentation flow, shared by gateway enrollment (setup-gateway.ts)
// and the post-provision Console enrollment (qrMenu below): render a payload as a QR or copy-paste
// JSON, with clipboard copy and a save-to-file fallback, tracked for cleanup.

import fs from "node:fs";
import { ask, err, note, readKeyWhile, secureFile } from "./lib/host.js";
import { fitsInQr, renderQrImageGif, renderQrTerminal } from "./render-provisioning-qr.js";
import { BLOB_FILE, CONSOLE_JSON_FILE, QR_GIF } from "./setup-constants.js";

////////////////////////////////
//  Temp file cleanup (saved enrollment artifacts)

// Files Setup Gateway saved this run. They carry the gateway's enrollment payload, so they must
// never be left behind: cleaned on success, on back-out, and on ^C.
const tempFiles = new Set<string>();

export function trackTemp(path: string): void {
	tempFiles.add(path);
}

export function cleanupTemps(): void {
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
//  Present flow

/** Best-effort copy to the system clipboard: OSC 52 (works over SSH, and in tmux with set-clipboard
 * on) plus a platform tool when one is present. Returns whether a platform tool confirmed the copy -
 * OSC 52 is fire-and-forget, so it cannot be confirmed. */
async function tryClipboardCopy(text: string): Promise<boolean> {
	process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	for (const argv of [["wl-copy"], ["xclip", "-selection", "clipboard"], ["pbcopy"], ["clip.exe"]]) {
		try {
			const proc = Bun.spawn(argv, { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
			if ((await proc.exited) === 0) return true;
		} catch {
			// Tool not installed - try the next.
		}
	}
	return false;
}

/** What the screen does instead of offering a way past itself. Supplied only by gateway enrollment;
 * the admin Console flow has nothing to wait for and keeps its continue action. */
export interface EnrollSettle {
	/** True once the phone's sealed bundle has landed. Polled while the screen is open. */
	installed: () => Promise<boolean>;
	/** The status line under the options, rewritten in place on every poll. */
	status: () => string;
	/** True once the gateway's enrollment window has closed, which offers an arm-again in place. */
	expired: () => boolean;
	/** The fingerprint the phone must be showing. Printed beside the artifact, because a phone that
	 * says "confirm this matches the Gateway terminal" over a terminal showing no such value is
	 * asking for a comparison that cannot be made. */
	sas: string;
	/** Set when the gateway opened no LAN listener, so a paste is the only route in. */
	lanNote?: string;
}

export type ArtifactAction = "continue" | "back" | "settled" | "rearm" | "paste";

/**
 * The settling half of the artifact screen: the payload is already on screen, and this waits for the
 * phone rather than offering a way past.
 *
 * There is no continue action here ON PURPOSE. The keypress that used to sit between this screen and
 * the wait loop is exactly what let an admin walk past the comparison without making it, and its
 * label ("Done. Continue Enrollment") promised a next step that did not exist.
 */
async function waitOnArtifact(
	heading: string,
	saveLabel: string,
	save: () => Promise<string>,
	settle: EnrollSettle,
): Promise<ArtifactAction> {
	for (;;) {
		console.log(`\n  ${heading}`);
		console.log(`\n  Your phone must show this exact code:  ${settle.sas}`);
		console.log("  If it shows anything else, do not approve it on the phone.");
		if (settle.lanNote) console.log(`\n  ${settle.lanNote}`);
		console.log(`\n    1) ${saveLabel}`);
		console.log("    p) Paste the bundle here");
		// Offered at all times, not only past the deadline. The options are printed once and only the
		// status line is rewritten after that, so a listing gated on expiry would still say "1, p, b"
		// under a status line telling the admin to press r. Re-arming early is useful anyway.
		console.log("    r) Arm again, with a fresh code");
		console.log("    b) Back");
		console.log("");
		const got = await readKeyWhile({
			poll: settle.installed,
			// Rewritten in place rather than appended, or a ten-minute wait scrolls the QR away.
			tick: () => process.stdout.write(`\r\x1b[2K  ${settle.status()}`),
			intervalMs: 1000,
		});
		process.stdout.write("\n");
		if (got.kind === "settled") return "settled";
		const key = got.key.toLowerCase();
		if (key === "b") return "back";
		// Handed back to the caller rather than read here: a paste needs a whole line, and the raw
		// mode this screen runs in is torn down only once readKeyWhile has returned.
		if (key === "p") return "paste";
		if (key === "r") return "rearm";
		if (key === "1") {
			try {
				note(`Saved: ${await save()}`);
			} catch (e) {
				err(e instanceof Error ? e.message : String(e));
			}
		}
		// Anything else just redraws, which is also what a stray arrow key should do.
	}
}

/** Render + display the gateway's admit payload, then offer to continue, save it to a file, or back
 * out. `render` prints the artifact on screen; `save` writes it to a temp file (tracked for cleanup)
 * and returns the path. With `settle`, the continue action is replaced by a wait on the phone. */
async function presentArtifact(
	heading: string,
	continueLabel: string,
	saveLabel: string,
	render: () => void,
	save: () => Promise<string>,
	settle?: EnrollSettle,
): Promise<ArtifactAction> {
	render();
	if (settle) return await waitOnArtifact(heading, saveLabel, save, settle);
	for (;;) {
		console.log(`\n  ${heading}`);
		console.log(`    1) ${continueLabel}`);
		console.log(`    2) ${saveLabel}`);
		console.log("    b) Back");
		const choice = ask("  >").toLowerCase();
		if (choice === "1") return "continue";
		if (choice === "b") return "back";
		if (choice === "2") {
			try {
				const saved = await save();
				note(`Saved: ${saved}`);
			} catch (e) {
				err(e instanceof Error ? e.message : String(e));
			}
		} else {
			err("Enter 1, 2, or b.");
		}
	}
}

/** The blob, validated to fit a single QR. The gateway-bridge transport creds are pulled from the
 * Router on demand, not bundled, so the blob sits well under a QR's ~2.9 KB ceiling. Guards against a
 * future field pushing it over with a clear error instead of qrcode-generator's raw overflow. */
function qrPayload(blobText: string): string {
	if (!fitsInQr(blobText)) {
		throw new Error(`blob is ${blobText.length} bytes - too large for a QR; use paste or file import`);
	}
	return blobText;
}

/** The shared "send this to your phone" present-flow for both gateway enrollment and the admin
 * Console enrollment: choose a QR or copy-paste JSON for the same payload, each with display, a
 * clipboard copy (JSON), and a save-to-file fallback, in one consistent submenu. Returns "continue"
 * (the caller's primary action - the gateway then waits for the bundle, the admin just finishes) or
 * "back". Saves are tracked as temps so the caller's cleanupTemps() wipes them on exit. */
export async function presentEnrollment(
	payload: string,
	opts: {
		title: string;
		/** The primary action's label. Unused with `settle`, which has no way past itself to label. */
		continueLabel?: string;
		qrScanHint: string;
		jsonScanHint: string;
		qrGifPath: string;
		jsonFilePath: string;
		qrSaveLabel: string;
		jsonSaveLabel: string;
		settle?: EnrollSettle;
	},
): Promise<ArtifactAction> {
	for (;;) {
		console.log(`\n${opts.title}`);
		console.log("  1) Show as QR Code");
		console.log("  2) Show as JSON Copy-pasta");
		console.log("  b) Back");
		const choice = ask(">").toLowerCase();

		if (choice === "b") return "back";
		if (choice === "1") {
			const action = await presentArtifact(
				opts.qrScanHint,
				opts.continueLabel ?? "",
				opts.qrSaveLabel,
				() => {
					// A payload too dense for a QR throws in qrPayload; offer JSON/save instead of crashing.
					try {
						const { ansi, modules } = renderQrTerminal(qrPayload(payload));
						process.stdout.write(ansi);
						console.error(`${modules}x${modules} modules, needs ~${modules + 4} terminal columns`);
					} catch (e) {
						err(e instanceof Error ? e.message : String(e));
						console.log("  Too big for a QR - use option 2 (JSON) or Save below.");
					}
				},
				async () => {
					const { gif } = renderQrImageGif(qrPayload(payload));
					await Bun.write(opts.qrGifPath, gif);
					secureFile(opts.qrGifPath);
					trackTemp(opts.qrGifPath);
					return opts.qrGifPath;
				},
				opts.settle,
			);
			// Only a back-out returns to the QR-versus-JSON choice; every other action is the caller\u0027s.
			if (action !== "back") return action;
		} else if (choice === "2") {
			const pretty = JSON.stringify(JSON.parse(payload), null, 2);
			const copied = await tryClipboardCopy(pretty);
			const action = await presentArtifact(
				opts.jsonScanHint,
				opts.continueLabel ?? "",
				opts.jsonSaveLabel,
				() => {
					console.log(
						copied
							? "\n  Copied the enrollment JSON to your clipboard. Try pasting it on your phone."
							: "\n  Tried to copy the enrollment JSON to your clipboard. Try pasting; if nothing pastes, use Save below.",
					);
				},
				async () => {
					await Bun.write(opts.jsonFilePath, pretty);
					secureFile(opts.jsonFilePath);
					trackTemp(opts.jsonFilePath);
					return opts.jsonFilePath;
				},
				opts.settle,
			);
			if (action !== "back") return action;
		} else {
			err("Enter 1, 2, or b.");
		}
	}
}

/** Post-setup: present the Console enrollment blob to the phone as a QR or copy-paste JSON, through
 * the shared present-flow. Any saved artifact is wiped on exit; the durable 0600 blob stays. */
export async function qrMenu(): Promise<void> {
	const blob = await Bun.file(BLOB_FILE)
		.text()
		.catch(() => "");
	if (!blob) {
		err("could not read the setup code (is it present?)");
		return;
	}
	try {
		await presentEnrollment(blob, {
			title: "Setup code - send to your phone:",
			continueLabel: "Done",
			qrScanHint: "Scan this in the Switchboard app, on Scan your setup code.",
			jsonScanHint: "Paste this into the Switchboard app, on Scan your setup code.",
			qrGifPath: QR_GIF,
			jsonFilePath: CONSOLE_JSON_FILE,
			qrSaveLabel: "Save Setup Code QR Instead",
			jsonSaveLabel: "Save Setup Code JSON Instead",
		});
	} finally {
		cleanupTemps();
	}
	note("Done.");
}
