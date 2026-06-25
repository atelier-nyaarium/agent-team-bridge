import qrcode from "qrcode-generator";
import { fingerprint, type Identity } from "../../shared/crypto.js";

////////////////////////////////
//  Constants

/** The gateway writes its raw admit-gateway payload here while arming, so the setup script can
 * re-render it as a QR or pretty JSON instead of scraping the rendered QR out of docker logs. */
export const ADMIT_PAYLOAD_FILE = "admit-payload.json";

////////////////////////////////
//  Interfaces & Types

/** The admit-gateway enrollment payload this Gateway presents for the owner to scan
 * (matches switchboard's EnrollmentPayloadSchema admit-gateway member). `lan` + `nonce`
 * are present when the Gateway opened a nonce-gated LAN listener for bundle delivery. */
export interface AdmitGatewayPayload {
	type: "admit-gateway";
	gatewayId: string;
	signPub: string;
	boxPub: string;
	lan?: { host: string; port: number };
	nonce?: string;
}

export interface EnrollDelivery {
	host: string;
	port: number;
	nonce: string;
}

////////////////////////////////
//  Functions & Helpers

export function admitGatewayPayload(
	identity: Identity,
	gatewayId: string,
	delivery?: EnrollDelivery,
): AdmitGatewayPayload {
	return {
		type: "admit-gateway",
		gatewayId,
		signPub: identity.sign.pub,
		boxPub: identity.box.pub,
		...(delivery ? { lan: { host: delivery.host, port: delivery.port }, nonce: delivery.nonce } : {}),
	};
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

/** Print the admit-gateway QR + SAS to the gateway console on startup, so the owner
 * can scan an un-admitted Gateway into the Domain. No-op once admitted. */
export function logAdmitGatewayQr(identity: Identity, gatewayId: string, delivery?: EnrollDelivery): void {
	const payload = admitGatewayPayload(identity, gatewayId, delivery);
	console.log(`\n[federation] Gateway "${gatewayId}" is not yet admitted to a Domain.`);
	console.log(`[federation] On the owner device, open Add Gateway and scan:\n`);
	console.log(terminalQr(JSON.stringify(payload)));
	console.log(`\n[federation] Confirm this fingerprint on the owner device: ${fingerprint(identity.sign.pub)}`);
	if (delivery) {
		console.log(
			`[federation] Waiting for the admin Console to deliver credentials over the LAN (${delivery.host}:${delivery.port})...\n`,
		);
	} else {
		console.log("");
	}
}
