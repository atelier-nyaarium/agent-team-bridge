import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceApprovalCoordinator } from "../federation-server/deviceApprovalCoordinator.js";
import { TrustRendezvousCoordinator } from "../federation-server/trustRendezvousCoordinator.js";
import { signProvisionTenant, signRemoveTenant } from "../shared/federation-tenants.js";
import { type RouterOnlyHarness, startRouterOnly } from "../testing/federationHarness.js";

const trustArm = (id: string, initiator: string, target: string, commitment: string) => ({
	step: "arm" as const,
	rendezvousId: id,
	initiatorOwnerSignPub: initiator,
	targetOwnerSignPub: target,
	commitment,
});

describe("Router coordinators", () => {
	it("re-arms idempotently, limits commitments, expires, and clears pending queries", () => {
		let now = 1_000;
		const c = new TrustRendezvousCoordinator({ now: () => now }, 100, 2, 4, 1);
		const initiator = "initiator";
		const target = "target";

		expect(c.handle(trustArm("r1", initiator, target, "one"))).toEqual({ ok: true });
		expect(c.handle(trustArm("r1", initiator, target, "one"))).toEqual({ ok: true });
		expect(c.handle(trustArm("r1", initiator, target, "two"))).toMatchObject({ ok: false });
		expect(c.handle(trustArm("r1", initiator, target, "three"))).toMatchObject({ ok: false });
		expect(c.pending(target)).toEqual([]);

		const targetCapped = new TrustRendezvousCoordinator({ now: () => now }, 100, 2, 4, 1);
		expect(targetCapped.handle(trustArm("r1", initiator, target, "one"))).toEqual({ ok: true });
		expect(targetCapped.handle(trustArm("r2", initiator, target, "two"))).toMatchObject({ ok: false });

		now = 1_101;
		expect(c.pending(target)).toEqual([]);
		expect(c.handle(trustArm("r2", initiator, target, "two"))).toEqual({ ok: true });
	});

	it("caps failed nonce attempts, preserves honest keys, caps windows, and expires by TTL", () => {
		let now = 1_000;
		const c = new DeviceApprovalCoordinator({ now: () => now }, 100, 2, 2);
		expect(c.handle({ step: "arm", approvalId: "a", nonce: "good" })).toEqual({ ok: true });
		expect(c.handle({ step: "arm", approvalId: "a", nonce: "good" })).toEqual({ ok: true });
		expect(c.handle({ step: "arm", approvalId: "a", nonce: "other" })).toMatchObject({ ok: false });
		expect(c.handle({ step: "arm", approvalId: "b", nonce: "b" })).toEqual({ ok: true });
		expect(c.handle({ step: "arm", approvalId: "c", nonce: "c" })).toMatchObject({ ok: false });

		expect(
			c.handle({ step: "join", approvalId: "a", nonce: "wrong-1", newSignPub: "sign", newBoxPub: "box" }),
		).toMatchObject({
			ok: false,
		});
		expect(
			c.handle({ step: "join", approvalId: "a", nonce: "wrong-2", newSignPub: "sign", newBoxPub: "box" }),
		).toMatchObject({
			ok: false,
		});
		expect(
			c.handle({ step: "join", approvalId: "a", nonce: "wrong-3", newSignPub: "sign", newBoxPub: "box" }),
		).toMatchObject({
			ok: false,
		});
		expect(c.handle({ step: "poll", approvalId: "a" })).toMatchObject({ ok: false });
		expect(c.handle({ step: "join", approvalId: "b", nonce: "b", newSignPub: "sign", newBoxPub: "box" })).toEqual({
			ok: true,
		});
		expect(
			c.handle({ step: "join", approvalId: "b", nonce: "b", newSignPub: "evil", newBoxPub: "evil" }),
		).toMatchObject({ ok: false });
		expect(c.handle({ step: "poll", approvalId: "b" })).toMatchObject({
			join: { newSignPub: "sign", newBoxPub: "box" },
		});

		now = 1_101;
		expect(c.handle({ step: "poll", approvalId: "b" })).toMatchObject({ ok: false });
	});
});

describe("tenant lifecycle through the Router", () => {
	let h: RouterOnlyHarness;
	const admin = () => h.set.domain.owner;

	const provision = (domainId: string, issuedAt = h.now(), nonce = randomBytes(12).toString("base64")) =>
		h.phone.console({
			enrollOp: {
				kind: "provision_tenant",
				provision: signProvisionTenant(
					{ domainId, displayName: domainId, issuedAt, nonce },
					admin().sign.priv,
					admin().sign.pub,
				),
			},
		});

	const removal = (domainId: string, issuedAt = h.now(), nonce = randomBytes(12).toString("base64")) =>
		h.phone.console({
			enrollOp: {
				kind: "remove_tenant",
				removal: signRemoveTenant({ domainId, issuedAt, nonce }, admin().sign.priv, admin().sign.pub),
			},
		});

	beforeAll(async () => {
		h = await startRouterOnly({ now: () => clock });
	});
	afterAll(async () => {
		if (h) await h.close();
	});

	it("refuses stale and future provisioning timestamps", async () => {
		const stale = await provision("stale", h.now() - 10_000_000);
		const future = await provision("future", h.now() + 10_000_000);
		expect(stale.status).toBe(400);
		expect(future.status).toBe(400);
	});

	it("regenerates a pending tenant invite, protects the admin from removal, and removes absent tenants idempotently", async () => {
		const first = await provision("tenant", h.now(), "Zmlyc3Q=");
		const second = await provision("tenant", h.now(), "c2Vjb25k");
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect((second.body as { nonce: string }).nonce).not.toBe((first.body as { nonce: string }).nonce);

		const removeAdmin = await removal(h.set.domain.id);
		expect(removeAdmin.status).toBe(400);
		expect((await removal("absent")).status).toBe(200);
	});
});

const clock = 1_000_000;
