import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verify } from "../shared/crypto.js";
import { deviceJoinSigningBytes } from "../shared/federation-device-approval.js";

const vector = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/device-join/vectors.json"), "utf8"),
);

describe("device join signing bytes", () => {
	it("reproduces the canonical signing vector and binds every key", () => {
		const bytes = deviceJoinSigningBytes(vector.approvalId, vector.nonce, vector.newSignPub, vector.newBoxPub);
		expect(verify(bytes, vector.signature, vector.signer.pub)).toBe(true);
		const changed = Buffer.from(vector.newBoxPub, "base64");
		changed[0] ^= 1;
		expect(
			verify(
				deviceJoinSigningBytes(vector.approvalId, vector.nonce, vector.newSignPub, changed.toString("base64")),
				vector.signature,
				vector.signer.pub,
			),
		).toBe(false);
	});
});
