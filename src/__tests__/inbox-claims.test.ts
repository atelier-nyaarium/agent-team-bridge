import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInboxClaims } from "../gateway/router/inboxClaims.js";
import { processAmbient } from "../shared/ambient.js";

const roots: string[] = [];
const address = "session:domain/gateway/session";

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("InboxClaims", () => {
	it("survives reopen and re-acks a claimed delivery with its outcome", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const first = createInboxClaims(root, { now: () => 10 });
		expect(first.claim(address, 4, 1)).toBeNull();
		first.setOutcome(address, 4, 1, "failed");

		const reopened = createInboxClaims(root, { now: () => 20 });
		const claim = reopened.claim(address, 4, 1);
		expect(claim).toMatchObject({ deliveryId: `${address}:4:1`, outcome: "failed" });
	});

	it("clears claims when the address epoch changes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		expect(claims.claim(address, 4, 1)).toBeNull();
		expect(claims.claim(address, 4, 2)).toBeNull();
	});

	it("returns a claim only for its matching epoch", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		claims.claim(address, 4, 1);

		expect(claims.get(address, 4, 1)).toMatchObject({ deliveryEpoch: 1 });
		expect(claims.get(address, 4, 2)).toBeNull();
	});
});
