import { describe, expect, it } from "vitest";
import { TenantAdmin } from "../federation-server/tenantAdmin.js";
import { REGISTER_MAX_SKEW_MS } from "../shared/admission.js";
import { adminOwner, fakeIO, freshStore, now, provision, removal } from "./helpers/tenant-admin.js";

describe("TenantAdmin persisted admin-op dedup (survives a restart)", () => {
	it("records the spent op nonce in the Secret on a successful provision", async () => {
		const { io, get } = fakeIO();
		const store = await freshStore(io);
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		expect((await admin.provisionTenant(provision("carol"))).ok).toBe(true);
		const ledger = get()?.seenAdminNonces ?? [];
		expect(ledger.some((e) => e.nonce.startsWith("provision_tenant\n"))).toBe(true);
		expect(store.loadSeenAdminNonces().length).toBe(1);
	});

	it("rejects a replayed provision on a FRESH TenantAdmin instance (post-restart)", async () => {
		const { io } = fakeIO();
		const signed = provision("carol");
		const store1 = await freshStore(io);
		const admin1 = new TenantAdmin(
			store1,
			() => adminOwner.sign.pub,
			() => now,
		);
		expect((await admin1.provisionTenant(signed)).ok).toBe(true);
		const store2 = await freshStore(io);
		const admin2 = new TenantAdmin(
			store2,
			() => adminOwner.sign.pub,
			() => now,
		);
		const replay = await admin2.provisionTenant(signed);
		expect(replay.ok).toBe(false);
		expect(replay.error).toMatch(/replayed/);
	});

	it("rejects a replayed DESTRUCTIVE remove on a FRESH instance, so it cannot re-evict a re-hosted tenant", async () => {
		const { io } = fakeIO();
		const removeSigned = removal("carol", now, "ZGVzdHJveQ==");
		const store1 = await freshStore(io);
		const admin1 = new TenantAdmin(
			store1,
			() => adminOwner.sign.pub,
			() => now,
		);
		await admin1.provisionTenant(provision("carol", "Carol", now, "cDE="));
		expect((await admin1.removeTenant(removeSigned)).ok).toBe(true);
		const reprov = await admin1.provisionTenant(provision("carol", "Carol", now, "cDI="));
		expect(reprov.ok).toBe(true);
		expect(store1.loadDomain("carol")).not.toBeNull();
		const store2 = await freshStore(io);
		const admin2 = new TenantAdmin(
			store2,
			() => adminOwner.sign.pub,
			() => now,
		);
		const replayed = await admin2.removeTenant(removeSigned);
		expect(replayed.ok).toBe(false);
		expect(replayed.error).toMatch(/replayed/);
		expect(store2.loadDomain("carol")).not.toBeNull();
	});

	it("a different scope with the same nonce string is independent (provision vs remove)", async () => {
		const { io } = fakeIO();
		const store = await freshStore(io);
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const sharedNonce = "c2hhcmVk";
		expect((await admin.provisionTenant(provision("carol", "Carol", now, sharedNonce))).ok).toBe(true);
		const rem = await admin.removeTenant(removal("carol", now, sharedNonce));
		expect(rem.ok).toBe(true);
	});

	it("prunes a ledger entry older than the skew window so the nonce is fresh again", async () => {
		const { io } = fakeIO();
		let clock = now;
		const store = await freshStore(io);
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => clock,
		);
		expect((await admin.provisionTenant(provision("carol", "Carol", clock, "cHJ1bmU="))).ok).toBe(true);
		clock = now + 10_000_000;
		const again = await admin.provisionTenant(provision("carol", "Carol", clock, "cHJ1bmU="));
		expect(again.ok).toBe(true);
	});

	it("a FUTURE-skewed remove replayed while still skew-valid is rejected by the retained ledger", async () => {
		const { io } = fakeIO();
		let clock = now;
		const store = await freshStore(io);
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => clock,
		);
		expect((await admin.provisionTenant(provision("carol", "Carol", now, "cDE="))).ok).toBe(true);
		const future = now + REGISTER_MAX_SKEW_MS;
		const removeSigned = removal("carol", future, "ZnV0dXJl");
		expect((await admin.removeTenant(removeSigned)).ok).toBe(true);
		clock = now + REGISTER_MAX_SKEW_MS + 1;
		const replay = await admin.removeTenant(removeSigned);
		expect(replay.ok).toBe(false);
		expect(replay.error).toMatch(/replayed/);
	});
});
