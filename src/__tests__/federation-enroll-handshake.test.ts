import { describe, expect, it } from "vitest";
import { EnrollHandshakeCoordinator } from "../federation-server/enrollHandshakeCoordinator.js";
import { processAmbient } from "../shared/ambient.js";
import type { EnrollReveal } from "../shared/federation-lifecycle.js";

const reveal = (tag: string): EnrollReveal => ({
	ownerSignPub: `sign-${tag}`,
	ownerBoxPub: `box-${tag}`,
	domainId: `dom-${tag}`,
	salt: `salt-${tag}`,
});

describe("EnrollHandshakeCoordinator (dumb broker)", () => {
	it("relays commits then reveals between the two roles", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient());
		const id = "hsX";

		// Admin commits first: no peer yet.
		expect(c.handle({ step: "commit", handshakeId: id, role: "ADMIN", commitment: "cA" })).toEqual({
			ok: true,
			peerCommitment: undefined,
		});
		// Enrollee commits: now each side can see the other's commitment.
		expect(c.handle({ step: "commit", handshakeId: id, role: "ENROLLEE", commitment: "cE" })).toEqual({
			ok: true,
			peerCommitment: "cA",
		});
		// Admin re-polls (idempotent same commit) and now sees the enrollee's commitment.
		expect(c.handle({ step: "commit", handshakeId: id, role: "ADMIN", commitment: "cA" })).toEqual({
			ok: true,
			peerCommitment: "cE",
		});

		// Reveals relay the same way.
		expect(c.handle({ step: "reveal", handshakeId: id, role: "ADMIN", reveal: reveal("A") })).toEqual({
			ok: true,
			peerReveal: undefined,
		});
		expect(c.handle({ step: "reveal", handshakeId: id, role: "ENROLLEE", reveal: reveal("E") })).toEqual({
			ok: true,
			peerReveal: reveal("A"),
		});
		expect(c.handle({ step: "reveal", handshakeId: id, role: "ADMIN", reveal: reveal("A") })).toEqual({
			ok: true,
			peerReveal: reveal("E"),
		});
	});

	it("binds a role slot to its first committer (anti-hijack) but allows an idempotent re-commit", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient());
		c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "first" });
		// A different commitment for the bound role is refused (never overwrites).
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "other" }).ok).toBe(false);
		// The same commitment is an idempotent poll.
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "first" }).ok).toBe(true);
	});

	it("caps commit attempts per window (fresh bindings + floods charge; an idempotent re-poll does not)", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient(), 600_000, 3, 256);
		// maxAttempts=3: the two role bindings charge, an idempotent re-poll does not, and a flood
		// of DIFFERENT commitments for a bound role charges too - so the 4th charged commit trips
		// the cap and tears the window down.
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "c1" }).ok).toBe(true);
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "c1" }).ok).toBe(true); // re-poll, no charge
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ENROLLEE", commitment: "c2" }).ok).toBe(true);
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ENROLLEE", commitment: "c2" }).ok).toBe(true); // re-poll
		// A different ENROLLEE commitment (charged) then a 3rd fresh one trips the cap.
		expect(c.handle({ step: "commit", handshakeId: "h", role: "ENROLLEE", commitment: "x3" }).ok).toBe(false); // bound -> refused
		const capped = c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "x4" });
		expect(capped.ok).toBe(false);
		expect(capped.error).toBeTruthy();
		// Window torn down: a reveal now finds nothing.
		expect(c.handle({ step: "reveal", handshakeId: "h", role: "ADMIN", reveal: reveal("A") }).ok).toBe(false);
	});

	it("bounds total concurrent windows", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient(), 600_000, 10, 2);
		expect(c.handle({ step: "commit", handshakeId: "a", role: "ADMIN", commitment: "c" }).ok).toBe(true);
		expect(c.handle({ step: "commit", handshakeId: "b", role: "ADMIN", commitment: "c" }).ok).toBe(true);
		const overflow = c.handle({ step: "commit", handshakeId: "c", role: "ADMIN", commitment: "c" });
		expect(overflow.ok).toBe(false);
		expect(overflow.error).toBeTruthy();
	});

	it("rejects a reveal before its commit", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient());
		expect(c.handle({ step: "reveal", handshakeId: "h", role: "ADMIN", reveal: reveal("A") }).ok).toBe(false);
	});

	it("cancel evicts the window", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient());
		c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "c" });
		expect(c.handle({ step: "cancel", handshakeId: "h", role: "ADMIN" })).toEqual({ ok: true });
		// After cancel, a reveal finds no window.
		expect(c.handle({ step: "reveal", handshakeId: "h", role: "ADMIN", reveal: reveal("A") }).ok).toBe(false);
	});

	it("sweeps windows past the TTL (injected clock)", () => {
		let t = 1_000;
		const c = new EnrollHandshakeCoordinator({ now: () => t }, 100, 10, 256);
		c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "c" });
		t = 1_000 + 101; // past the 100ms TTL
		// The next call sweeps the stale window; a reveal then finds nothing.
		expect(c.handle({ step: "reveal", handshakeId: "h", role: "ADMIN", reveal: reveal("A") }).ok).toBe(false);
	});

	it("never returns a SAS or any computed value beyond the relayed frames", () => {
		const c = new EnrollHandshakeCoordinator(processAmbient());
		const r = c.handle({ step: "commit", handshakeId: "h", role: "ADMIN", commitment: "c" });
		// Only ok/error/peerCommitment/peerReveal exist; the Router computes nothing.
		expect(Object.keys(r).sort()).toEqual(["ok", "peerCommitment"].sort());
		expect("sas" in r).toBe(false);
	});
});
