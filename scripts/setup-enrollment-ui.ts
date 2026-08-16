// The "send this to your phone" presentation flow, shared by gateway enrollment (setup-gateway.ts)
// and the post-provision Console enrollment (qrMenu below): render a payload as a QR or copy-paste
// JSON, with clipboard copy and a save-to-file fallback, tracked for cleanup.

import fs from "node:fs";
import { ask, err, note, secureFile } from "./lib/host.js";
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

/** Render + display the gateway's admit payload, then offer to continue, save it to a file, or back
 * out. `render` prints the artifact on screen; `save` writes it to a temp file (tracked for cleanup)
 * and returns the path. Returns "continue" or "back". */
async function presentArtifact(
	heading: string,
	continueLabel: string,
	saveLabel: string,
	render: () => void,
	save: () => Promise<string>,
): Promise<"continue" | "back"> {
	render();
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
		continueLabel: string;
		qrScanHint: string;
		jsonScanHint: string;
		qrGifPath: string;
		jsonFilePath: string;
		qrSaveLabel: string;
		jsonSaveLabel: string;
	},
): Promise<"continue" | "back"> {
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
				opts.continueLabel,
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
			);
			if (action === "continue") return "continue";
		} else if (choice === "2") {
			const pretty = JSON.stringify(JSON.parse(payload), null, 2);
			const copied = await tryClipboardCopy(pretty);
			const action = await presentArtifact(
				opts.jsonScanHint,
				opts.continueLabel,
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
			);
			if (action === "continue") return "continue";
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
