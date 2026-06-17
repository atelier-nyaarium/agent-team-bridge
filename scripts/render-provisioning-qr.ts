// Render the provisioning blob as a QR, for provision-console.sh's post-setup menu.
// The QR encodes the blob JSON verbatim (the same text the app imports), so a scan
// yields exactly what the clipboard-paste flow expects. bun-only (reuses the project's
// qrcode-generator dep; no new dependency).
//   env in: SB_BLOB      path to the provisioning blob (the text to encode)
//           SB_QR_MODE   "terminal" (ANSI half-block to stdout) | "image" (GIF to SB_QR_OUT)
//           SB_QR_OUT    output path (image mode)

import qrcode from "qrcode-generator";

function reqEnv(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
	return v;
}

const text = await Bun.file(reqEnv("SB_BLOB")).text();

// Strongest error correction the payload fits in: M is more scan-robust, but the full
// blob (~2.7 KB) overflows M's max version, so fall back to L. qrcode-generator throws
// "code length overflow" from make() when the data exceeds the chosen EC's capacity.
function build(ec: "M" | "L") {
	const qr = qrcode(0, ec);
	qr.addData(text, "Byte");
	qr.make();
	return qr;
}
let ec: "M" | "L" = "M";
let qr: ReturnType<typeof qrcode>;
try {
	qr = build("M");
} catch {
	ec = "L";
	qr = build("L");
}
const n = qr.getModuleCount();

if ((process.env.SB_QR_MODE ?? "terminal") === "image") {
	// A crisp GIF, camera-friendly at any size (no terminal-width limit).
	const out = reqEnv("SB_QR_OUT");
	const dataUrl = qr.createDataURL(6, 4);
	await Bun.write(out, Buffer.from(dataUrl.split(",")[1], "base64"));
	console.error(`wrote ${out}  (${n}x${n} modules, EC=${ec})`);
} else {
	// Terminal: half-block (two module-rows per text-row) with forced black/white so it
	// scans on any theme; color codes run-length-encoded to keep the output compact.
	// Wide payload -> needs ~n+4 columns (a dynamic/wide terminal handles it).
	const quiet = 2;
	const dark = (r: number, c: number) => r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c);
	let out = "";
	for (let r = -quiet; r < n + quiet; r += 2) {
		let line = "";
		let cur = "";
		for (let c = -quiet; c < n + quiet; c++) {
			const code = `38;5;${dark(r, c) ? 0 : 15};48;5;${dark(r + 1, c) ? 0 : 15}`;
			if (code !== cur) {
				line += `\x1b[${code}m`;
				cur = code;
			}
			line += "▀"; // upper half block
		}
		out += `${line}\x1b[0m\n`;
	}
	process.stdout.write(out);
	console.error(`${n}x${n} modules, EC=${ec}, needs ~${n + quiet * 2} terminal columns`);
}
