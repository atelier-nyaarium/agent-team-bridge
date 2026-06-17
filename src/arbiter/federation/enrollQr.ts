import qrcode from "qrcode-generator";
import { fingerprint, type Identity } from "../../shared/crypto.js";

////////////////////////////////
//  Interfaces & Types

/** The admit-switch enrollment payload this Switch presents for the owner to scan
 * (matches switchboard's EnrollmentPayloadSchema admit-switch member). */
export interface AdmitSwitchPayload {
	type: "admit-switch";
	switchId: string;
	signPub: string;
	boxPub: string;
}

////////////////////////////////
//  Functions & Helpers

export function admitSwitchPayload(identity: Identity, switchId: string): AdmitSwitchPayload {
	return { type: "admit-switch", switchId, signPub: identity.sign.pub, boxPub: identity.box.pub };
}

/** Render a QR as ANSI background-colored cells - forced black-on-white so it
 * scans regardless of the terminal theme - with a 4-module quiet zone. Each
 * module is two spaces wide to stay roughly square. */
export function terminalQr(text: string): string {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	const light = "\x1b[47m  \x1b[0m";
	const dark = "\x1b[40m  \x1b[0m";
	const quiet = 4;
	const lines: string[] = [];
	for (let row = -quiet; row < n + quiet; row++) {
		let line = "";
		for (let col = -quiet; col < n + quiet; col++) {
			const isDark = row >= 0 && row < n && col >= 0 && col < n && qr.isDark(row, col);
			line += isDark ? dark : light;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

/** Print the admit-switch QR + SAS to the arbiter console on startup, so the owner
 * can scan an un-admitted Switch into the Domain. No-op once admitted. */
export function logAdmitSwitchQr(identity: Identity, switchId: string): void {
	const payload = admitSwitchPayload(identity, switchId);
	console.log(`\n[federation] Switch "${switchId}" is not yet admitted to a Domain.`);
	console.log(`[federation] On the owner device, open Enroll by QR and scan:\n`);
	console.log(terminalQr(JSON.stringify(payload)));
	console.log(`\n[federation] Confirm this fingerprint on the owner device: ${fingerprint(identity.sign.pub)}\n`);
}
