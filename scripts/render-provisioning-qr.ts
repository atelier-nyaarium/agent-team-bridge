// Render the provisioning blob as a QR. The QR encodes the blob JSON verbatim (the same text the
// app imports), so a scan yields exactly what the clipboard-paste flow expects. Reuses the
// project's qrcode-generator dep; no new dependency.

import qrcode from "qrcode-generator";

////////////////////////////////
//  Interfaces & Types

export interface QrStats {
	modules: number;
	ec: "M" | "L";
}

////////////////////////////////
//  Functions & Helpers

/** Build the QR at the strongest error correction the payload fits: M is more scan-robust, but the
 * full blob (~2.7 KB) overflows M's max version, so fall back to L. qrcode-generator throws "code
 * length overflow" from make() when the data exceeds the chosen EC's capacity. */
function buildQr(text: string): { qr: ReturnType<typeof qrcode>; modules: number; ec: "M" | "L" } {
	const make = (ec: "M" | "L") => {
		const qr = qrcode(0, ec);
		qr.addData(text, "Byte");
		qr.make();
		return qr;
	};
	try {
		const qr = make("M");
		return { qr, modules: qr.getModuleCount(), ec: "M" };
	} catch {
		try {
			const qr = make("L");
			return { qr, modules: qr.getModuleCount(), ec: "L" };
		} catch {
			// Even L overflowed: a readable error beats qrcode-generator's raw "code length overflow".
			throw new Error(
				`payload too large to encode as a QR (${text.length} bytes) - use paste or file import instead`,
			);
		}
	}
}

/** ANSI half-block QR for a terminal: two module-rows per text-row, forced black/white so it scans
 * on any theme, color codes run-length-encoded to keep the output compact. Needs ~modules+4
 * terminal columns. Returns the printable string plus render stats. */
export function renderQrTerminal(text: string): QrStats & { ansi: string } {
	const { qr, modules: n, ec } = buildQr(text);
	const quiet = 2;
	const dark = (r: number, c: number) => r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c);
	let ansi = "";
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
		ansi += `${line}\x1b[0m\n`;
	}
	return { ansi, modules: n, ec };
}

/** A crisp GIF, camera-friendly at any size (no terminal-width limit). Returns the bytes for the
 * caller to write. */
export function renderQrImageGif(text: string): QrStats & { gif: Buffer } {
	const { qr, modules: n, ec } = buildQr(text);
	const dataUrl = qr.createDataURL(6, 4);
	return { gif: Buffer.from(dataUrl.split(",")[1], "base64"), modules: n, ec };
}

////////////////////////////////
//  CLI shim (back-compat: SB_BLOB path, SB_QR_MODE terminal|image, SB_QR_OUT)

if (import.meta.main) {
	const reqEnv = (name: string): string => {
		const v = process.env[name];
		if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
		return v;
	};
	const text = await Bun.file(reqEnv("SB_BLOB")).text();
	if ((process.env.SB_QR_MODE ?? "terminal") === "image") {
		const out = reqEnv("SB_QR_OUT");
		const { gif, modules, ec } = renderQrImageGif(text);
		await Bun.write(out, gif);
		console.error(`wrote ${out}  (${modules}x${modules} modules, EC=${ec})`);
	} else {
		const { ansi, modules, ec } = renderQrTerminal(text);
		process.stdout.write(ansi);
		console.error(`${modules}x${modules} modules, EC=${ec}, needs ~${modules + 4} terminal columns`);
	}
}
