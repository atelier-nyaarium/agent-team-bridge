import { describe, expect, it } from "vitest";
import { TrustRendezvousCoordinator } from "../federation-server/trustRendezvousCoordinator.js";
import type { EnrollReveal } from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Helpers

const INIT = "initiator-owner-key";
const TARGET = "target-owner-key";

function reveal(owner: string): EnrollReveal {
	return { ownerSignPub: owner, ownerBoxPub: `${owner}-box`, domainId: "alice", salt: "c2FsdA==" };
}

function arm(c: TrustRendezvousCoordinator, id: string, commitment: string, init = INIT, target = TARGET) {
	return c.handle({
		step: "arm",
		rendezvousId: id,
		initiatorOwnerSignPub: init,
		targetOwnerSignPub: target,
		commitment,
	});
}

////////////////////////////////
//  Tests

describe("TrustRendezvousCoordinator", () => {
	it("arms, indexes by target, and surfaces the pending highlight", () => {
		const c = new TrustRendezvousCoordinator();
		expect(arm(c, "r1", "ci").ok).toBe(true);
		const pending = c.pending(TARGET);
		expect(pending).toEqual([{ initiatorOwnerSignPub: INIT, rendezvousId: "r1" }]);
		// A different owner sees nothing armed at them.
		expect(c.pending("someone-else")).toEqual([]);
	});

	it("relays commit then reveal between the two sides", () => {
		const c = new TrustRendezvousCoordinator();
		arm(c, "r1", "ci");
		// The target joins; gets the initiator's commitment.
		const join = c.handle({ step: "join", rendezvousId: "r1", joinerOwnerSignPub: TARGET, commitment: "ct" });
		expect(join).toEqual({ ok: true, peerCommitment: "ci" });
		// The initiator re-arms (polls) and now sees the target's commitment.
		expect(arm(c, "r1", "ci").peerCommitment).toBe("ct");
		// Reveals relay both ways.
		expect(c.handle({ step: "reveal", rendezvousId: "r1", side: "INITIATOR", reveal: reveal(INIT) }).ok).toBe(true);
		const tReveal = c.handle({ step: "reveal", rendezvousId: "r1", side: "TARGET", reveal: reveal(TARGET) });
		expect(tReveal.peerReveal?.ownerSignPub).toBe(INIT);
	});

	it("hides a fully-revealed rendezvous from the pending highlight", () => {
		const c = new TrustRendezvousCoordinator();
		arm(c, "r1", "ci");
		c.handle({ step: "join", rendezvousId: "r1", joinerOwnerSignPub: TARGET, commitment: "ct" });
		c.handle({ step: "reveal", rendezvousId: "r1", side: "INITIATOR", reveal: reveal(INIT) });
		expect(c.pending(TARGET).length).toBe(1); // still in-progress (target not revealed)
		c.handle({ step: "reveal", rendezvousId: "r1", side: "TARGET", reveal: reveal(TARGET) });
		expect(c.pending(TARGET)).toEqual([]); // done
	});

	it("refuses a join from anyone but the armed target", () => {
		const c = new TrustRendezvousCoordinator();
		arm(c, "r1", "ci");
		const bad = c.handle({ step: "join", rendezvousId: "r1", joinerOwnerSignPub: "imposter", commitment: "cx" });
		expect(bad.ok).toBe(false);
	});

	it("refuses a re-arm that names a different owner pair for the same rendezvousId", () => {
		const c = new TrustRendezvousCoordinator();
		arm(c, "r1", "ci");
		const bad = arm(c, "r1", "ci", "other-initiator", TARGET);
		expect(bad.ok).toBe(false);
	});

	it("an idempotent re-arm is a free poll (does not charge the attempt cap)", () => {
		const c = new TrustRendezvousCoordinator(600_000, 2);
		expect(arm(c, "r1", "ci").ok).toBe(true);
		expect(arm(c, "r1", "ci").ok).toBe(true);
		expect(arm(c, "r1", "ci").ok).toBe(true); // would exceed 2 if charged
	});

	it("tears down after too many DIFFERENT commitments (flood)", () => {
		const c = new TrustRendezvousCoordinator(600_000, 2);
		arm(c, "r1", "c1");
		// A different commitment for the bound INITIATOR slot charges + is refused.
		expect(arm(c, "r1", "c2").ok).toBe(false);
		expect(arm(c, "r1", "c3").ok).toBe(false);
		// Window is gone after the cap.
		expect(c.pending(TARGET)).toEqual([]);
	});

	it("caps the arms indexed to one target (no pending-list flood)", () => {
		const c = new TrustRendezvousCoordinator(600_000, 10, 512, 2);
		expect(arm(c, "r1", "c1").ok).toBe(true);
		expect(arm(c, "r2", "c2").ok).toBe(true);
		expect(arm(c, "r3", "c3").ok).toBe(false); // over per-target cap
		expect(c.pending(TARGET).length).toBe(2);
	});

	it("cancel drops the rendezvous and de-indexes it", () => {
		const c = new TrustRendezvousCoordinator();
		arm(c, "r1", "ci");
		c.handle({ step: "cancel", rendezvousId: "r1" });
		expect(c.pending(TARGET)).toEqual([]);
	});

	it("sweeps an expired rendezvous", () => {
		let t = 1000;
		const c = new TrustRendezvousCoordinator(100, 10, 512, 32, () => t);
		arm(c, "r1", "ci");
		expect(c.pending(TARGET).length).toBe(1);
		t += 200;
		expect(c.pending(TARGET)).toEqual([]);
	});
});
