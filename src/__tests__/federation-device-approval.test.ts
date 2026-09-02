import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceApprovalCoordinator } from "../federation-server/deviceApprovalCoordinator.js";
import { verify } from "../shared/crypto.js";
import { deviceJoinSigningBytes } from "../shared/federation-device-approval.js";
import type { ConsoleApprovalResult } from "../shared/federation-lifecycle.js";

type SealedEnvelope = NonNullable<ConsoleApprovalResult["sealed"]>;

const sealed = (tag: string): SealedEnvelope => ({
	ephemeralPub: `eph-${tag}`,
	nonce: `n-${tag}`,
	ciphertext: `ct-${tag}`,
	signature: `sig-${tag}`,
});

const vector = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/device-join/vectors.json"), "utf8"),
);

describe("DeviceApprovalCoordinator (dumb broker)", () => {
	it("verifies the signed join vector and refuses a changed box key", () => {
		const bytes = deviceJoinSigningBytes(vector.approvalId, vector.nonce, vector.newSignPub, vector.newBoxPub);
		expect(verify(bytes, vector.signature, vector.signer.pub)).toBe(true);
		const changedBox = Buffer.from(vector.newBoxPub, "base64");
		changedBox[0] ^= 1;
		expect(
			verify(
				deviceJoinSigningBytes(
					vector.approvalId,
					vector.nonce,
					vector.newSignPub,
					changedBox.toString("base64"),
				),
				vector.signature,
				vector.signer.pub,
			),
		).toBe(false);
	});

	it("relays the full arm -> join -> poll -> approve -> fetch rendezvous", () => {
		const c = new DeviceApprovalCoordinator();
		const id = "appr";
		const nonce = "one-time";

		expect(c.handle({ step: "arm", approvalId: id, nonce })).toEqual({ ok: true });
		// Before N joins, the held device polls and sees nothing.
		expect(c.handle({ step: "poll", approvalId: id }).join).toBeUndefined();
		// N joins over the public ingress with its fresh console keys.
		expect(
			c.handle({
				step: "join",
				approvalId: id,
				nonce,
				newSignPub: "ns",
				newBoxPub: "nb",
				joinSig: "join-signature",
				device: "Pixel",
			}),
		).toEqual({ ok: true });
		// The held device polls and now sees N's join.
		expect(c.handle({ step: "poll", approvalId: id })).toEqual({
			ok: true,
			join: { newSignPub: "ns", newBoxPub: "nb", joinSig: "join-signature", device: "Pixel" },
		});
		// Before approval, N fetches and sees no sealed reply yet (keep polling).
		expect(c.handle({ step: "fetch", approvalId: id, nonce }).sealed).toBeUndefined();
		// The held device approves, parking the sealed transport reply.
		expect(c.handle({ step: "approve", approvalId: id, sealed: sealed("x") })).toEqual({ ok: true });
		// N fetches and receives the sealed reply.
		expect(c.handle({ step: "fetch", approvalId: id, nonce })).toEqual({ ok: true, sealed: sealed("x") });
	});

	it("nonce-gates join/fetch and returns one opaque error that never reveals window existence", () => {
		const c = new DeviceApprovalCoordinator();
		c.handle({ step: "arm", approvalId: "A", nonce: "secret-nonce" });

		// A wrong nonce on a LIVE window and any nonce on a NONEXISTENT window return the SAME opaque
		// error, so a probe of the public ingress cannot tell which approvalIds are armed.
		const wrongOnLive = c.handle({
			step: "join",
			approvalId: "A",
			nonce: "guess",
			newSignPub: "n",
			newBoxPub: "n",
		});
		const anyOnMissing = c.handle({
			step: "join",
			approvalId: "Z",
			nonce: "guess",
			newSignPub: "n",
			newBoxPub: "n",
		});
		expect(wrongOnLive.ok).toBe(false);
		expect(anyOnMissing.ok).toBe(false);
		expect(wrongOnLive.error).toBe(anyOnMissing.error);

		const wrongFetch = c.handle({ step: "fetch", approvalId: "A", nonce: "guess" });
		const missingFetch = c.handle({ step: "fetch", approvalId: "Z", nonce: "guess" });
		expect(wrongFetch.ok).toBe(false);
		expect(wrongFetch.error).toBe(missingFetch.error);

		// No join landed on the live window, and the probe of "Z" never created one.
		expect(c.handle({ step: "poll", approvalId: "A" }).join).toBeUndefined();
		expect(c.handle({ step: "poll", approvalId: "Z" }).ok).toBe(false);
	});

	it("re-signing replaces a parked join while different keys remain refused", () => {
		const c = new DeviceApprovalCoordinator();
		c.handle({ step: "arm", approvalId: "A", nonce: "good" });

		expect(
			c.handle({
				step: "join",
				approvalId: "A",
				nonce: "good",
				newSignPub: "ns",
				newBoxPub: "nb",
				joinSig: "original",
				device: "Pixel",
			}).ok,
		).toBe(true);
		expect(
			c.handle({
				step: "join",
				approvalId: "A",
				nonce: "good",
				newSignPub: "ns",
				newBoxPub: "nb",
				joinSig: "original",
			}).ok,
		).toBe(true);
		expect(
			c.handle({
				step: "join",
				approvalId: "A",
				nonce: "good",
				newSignPub: "ns",
				newBoxPub: "nb",
				joinSig: "resigned",
			}).ok,
		).toBe(true);
		// A different key, even WITH the correct nonce, cannot overwrite the honest join.
		expect(
			c.handle({ step: "join", approvalId: "A", nonce: "good", newSignPub: "EVIL", newBoxPub: "EVIL" }).ok,
		).toBe(false);
		// Poll returns the latest signature.
		expect(c.handle({ step: "poll", approvalId: "A" }).join).toEqual({
			newSignPub: "ns",
			newBoxPub: "nb",
			joinSig: "resigned",
		});
	});

	it("arm is idempotent for the same nonce and first-arm-wins for a different one", () => {
		const c = new DeviceApprovalCoordinator();
		expect(c.handle({ step: "arm", approvalId: "A", nonce: "n1" }).ok).toBe(true);
		expect(c.handle({ step: "arm", approvalId: "A", nonce: "n1" }).ok).toBe(true);
		// A different nonce for a live window is refused; H mints a fresh approvalId to restart.
		expect(c.handle({ step: "arm", approvalId: "A", nonce: "n2" }).ok).toBe(false);
	});

	it("tears a window down after the failed-nonce attempt cap (re-arm to restart)", () => {
		const c = new DeviceApprovalCoordinator(600_000, 2, 256);
		c.handle({ step: "arm", approvalId: "A", nonce: "good" });
		// maxAttempts=2: two charged misses are tolerated; the third trips the cap and evicts.
		expect(c.handle({ step: "join", approvalId: "A", nonce: "x1", newSignPub: "n", newBoxPub: "n" }).ok).toBe(
			false,
		);
		expect(c.handle({ step: "join", approvalId: "A", nonce: "x2", newSignPub: "n", newBoxPub: "n" }).ok).toBe(
			false,
		);
		expect(c.handle({ step: "join", approvalId: "A", nonce: "x3", newSignPub: "n", newBoxPub: "n" }).ok).toBe(
			false,
		);
		// Torn down: even the CORRECT nonce now finds nothing, and the held device's poll is gone.
		expect(c.handle({ step: "join", approvalId: "A", nonce: "good", newSignPub: "n", newBoxPub: "n" }).ok).toBe(
			false,
		);
		expect(c.handle({ step: "poll", approvalId: "A" }).ok).toBe(false);
	});

	it("does not charge an attempt for an idempotent join re-post (honest polling never trips the cap)", () => {
		const c = new DeviceApprovalCoordinator(600_000, 1, 256);
		c.handle({ step: "arm", approvalId: "A", nonce: "good" });
		// Join once, then re-post the same keys many times: no charge, so the window survives.
		expect(c.handle({ step: "join", approvalId: "A", nonce: "good", newSignPub: "ns", newBoxPub: "nb" }).ok).toBe(
			true,
		);
		for (let i = 0; i < 5; i++) {
			expect(
				c.handle({ step: "join", approvalId: "A", nonce: "good", newSignPub: "ns", newBoxPub: "nb" }).ok,
			).toBe(true);
		}
		expect(c.handle({ step: "poll", approvalId: "A" }).join).toEqual({ newSignPub: "ns", newBoxPub: "nb" });
	});

	it("bounds total concurrent windows (only arm grows the map)", () => {
		const c = new DeviceApprovalCoordinator(600_000, 10, 2);
		expect(c.handle({ step: "arm", approvalId: "a", nonce: "1" }).ok).toBe(true);
		expect(c.handle({ step: "arm", approvalId: "b", nonce: "2" }).ok).toBe(true);
		const overflow = c.handle({ step: "arm", approvalId: "c", nonce: "3" });
		expect(overflow.ok).toBe(false);
		expect(overflow.error).toContain("too many device approvals");
		// A public join can never create a window, so it cannot grow the map past the cap.
		expect(c.handle({ step: "join", approvalId: "d", nonce: "x", newSignPub: "n", newBoxPub: "n" }).ok).toBe(false);
		expect(c.handle({ step: "poll", approvalId: "d" }).ok).toBe(false);
	});

	it("cancel evicts the window", () => {
		const c = new DeviceApprovalCoordinator();
		c.handle({ step: "arm", approvalId: "A", nonce: "good" });
		expect(c.handle({ step: "cancel", approvalId: "A" })).toEqual({ ok: true });
		expect(c.handle({ step: "poll", approvalId: "A" }).ok).toBe(false);
	});

	it("sweeps windows past the TTL (injected clock)", () => {
		let t = 1_000;
		const c = new DeviceApprovalCoordinator(100, 10, 256, () => t);
		c.handle({ step: "arm", approvalId: "A", nonce: "good" });
		t = 1_000 + 101; // past the 100ms TTL
		// The next call sweeps the stale window; a poll then finds nothing.
		expect(c.handle({ step: "poll", approvalId: "A" }).ok).toBe(false);
	});
});
