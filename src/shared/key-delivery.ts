import { sign, verify } from "./crypto.js";
import type { KeyReceipt, KeyRequest } from "./schemasContentKey.js";

export type { KeyReceipt, KeyRequest } from "./schemasContentKey.js";

export function keyRequestSigningBytes(r: KeyRequest): Buffer {
	return Buffer.from(
		["KEYREQUEST_V1", r.domainId, r.requesterSignPub, r.epochs.join(","), String(r.at), r.nonce].join("\n"),
		"utf8",
	);
}

export function keyReceiptSigningBytes(r: KeyReceipt): Buffer {
	return Buffer.from(
		["KEYRECEIPT_V1", r.domainId, r.recipientSignPub, String(r.epoch), String(r.at), r.nonce].join("\n"),
		"utf8",
	);
}

export function signKeyRequest(request: KeyRequest, signPrivB64: string): KeyRequest {
	return { ...request, signature: sign(keyRequestSigningBytes(request), signPrivB64) };
}

export function verifyKeyRequest(request: KeyRequest): boolean {
	return verify(keyRequestSigningBytes(request), request.signature, request.requesterSignPub);
}

export function signKeyReceipt(receipt: KeyReceipt, signPrivB64: string): KeyReceipt {
	return { ...receipt, signature: sign(keyReceiptSigningBytes(receipt), signPrivB64) };
}

export function verifyKeyReceipt(receipt: KeyReceipt): boolean {
	return verify(keyReceiptSigningBytes(receipt), receipt.signature, receipt.recipientSignPub);
}
