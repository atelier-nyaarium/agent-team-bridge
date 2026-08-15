import { describe, expect, it } from "vitest";
import { TenantAdmin } from "../federation-server/tenantAdmin.js";
import { generateIdentity } from "../shared/crypto.js";
import {
	type FirstRoot,
	type ProvisionTenant,
	type RemoveTenant,
	type SetDisplayName,
	SignedFirstRootSchema,
	signFirstRoot,
	signProvisionTenant,
	signRemoveTenant,
	signSetDisplayName,
} from "../shared/federation-lifecycle.js";
import { adminOwner, firstRoot, freshStore, now, provision, removal } from "./helpers/tenant-admin.js";

describe("TenantAdmin provision_tenant", () => {
	it("creates a pending tenant on a valid admin-signed provision", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.provisionTenant(provision("carol"));
		expect(res.ok).toBe(true);
		expect(res.nonce).toBeTruthy();
		const slice = store.loadDomain("carol");
		expect(slice?.ownerSignPub).toBeNull();
		expect(slice?.displayName).toBe("Carol");
		expect(slice?.pendingTenant?.rooted).toBe(false);
		expect(slice?.pendingTenant?.nonce).toBe(res.nonce);
	});

	it("mints the invite nonce in the b64Field charset the friend's first_root requires", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const friend = generateIdentity();
		for (let i = 0; i < 25; i++) {
			const res = await admin.provisionTenant(provision("carol", "Carol", now, `bm9uY2U${i}`));
			expect(res.ok).toBe(true);
			const f: FirstRoot = {
				domainId: "carol",
				ownerSignPub: friend.sign.pub,
				ownerBoxPub: friend.box.pub,
				nonce: res.nonce as string,
				issuedAt: now,
			};
			expect(SignedFirstRootSchema.safeParse(signFirstRoot(f, friend.sign.priv)).success).toBe(true);
		}
	});

	it("rejects a provision signed by a non-admin key", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const attacker = generateIdentity();
		const p: ProvisionTenant = { domainId: "carol", displayName: "Carol", issuedAt: now, nonce: "YXR0YWNr" };
		const forged = signProvisionTenant(p, attacker.sign.priv, attacker.sign.pub);
		const res = await admin.provisionTenant(forged);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not admin-signed/);
		expect(store.loadDomain("carol")).toBeNull();
	});

	it("rejects when no admin key is pinned (admin Domain not rooted)", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => null,
			() => now,
		);
		const res = await admin.provisionTenant(provision("carol"));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no admin key pinned/);
	});

	it("rejects a stale provision (issuedAt outside the skew window)", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.provisionTenant(provision("carol", "Carol", now - 10_000_000));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/stale/);
	});

	it("rejects a replayed provision (same op nonce)", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const signed = provision("carol");
		expect((await admin.provisionTenant(signed)).ok).toBe(true);
		const replay = await admin.provisionTenant(signed);
		expect(replay.ok).toBe(false);
		expect(replay.error).toMatch(/replayed/);
	});

	it("refuses to re-stage an already-rooted Domain", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		expect((await admin.firstRoot(firstRoot("carol", friend, p.nonce as string))).ok).toBe(true);
		const restage = await admin.provisionTenant(provision("carol", "Carol", now, "cmVzdGFnZQ=="));
		expect(restage.ok).toBe(false);
		expect(restage.error).toMatch(/already rooted/);
	});

	it("re-provision of a still-pending Domain mints a FRESH invite nonce (QR regenerate)", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const first = await admin.provisionTenant(provision("carol", "Carol", now, "Zmlyc3Q="));
		const second = await admin.provisionTenant(provision("carol", "Carol", now, "c2Vjb25k"));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(second.nonce).not.toBe(first.nonce);
		expect(store.loadDomain("carol")?.pendingTenant?.nonce).toBe(second.nonce);
	});

	it("refuses to provision the admin's primary Domain", async () => {
		const store = await freshStore();
		store.saveDomain("alice", {
			ownerSignPub: adminOwner.sign.pub,
			ownerBoxPub: "b",
			admissions: [],
			revocations: [],
			isAdminDomain: true,
		});
		await new Promise((r) => setTimeout(r, 10));
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.provisionTenant(provision("alice"));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/the admin's Domain/);
	});
});

describe("TenantAdmin remove_tenant", () => {
	it("removes a tenant slice on a valid admin-signed removal", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await admin.provisionTenant(provision("carol"));
		expect(store.loadDomain("carol")).not.toBeNull();
		const res = await admin.removeTenant(removal("carol"));
		expect(res.ok).toBe(true);
		expect(store.loadDomain("carol")).toBeNull();
	});

	it("rejects a removal signed by a non-admin", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await admin.provisionTenant(provision("carol"));
		const attacker = generateIdentity();
		const r: RemoveTenant = { domainId: "carol", issuedAt: now, nonce: "YXR0Lg==" };
		const forged = signRemoveTenant(r, attacker.sign.priv, attacker.sign.pub);
		const res = await admin.removeTenant(forged);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not admin-signed/);
		expect(store.loadDomain("carol")).not.toBeNull();
	});

	it("removing an absent Domain is an idempotent no-op success", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.removeTenant(removal("ghost"));
		expect(res.ok).toBe(true);
	});

	it("a re-provision after a removal mints a fresh invite", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const first = await admin.provisionTenant(provision("carol", "Carol", now, "cDE="));
		await admin.removeTenant(removal("carol", now, "cjE="));
		expect(store.loadDomain("carol")).toBeNull();
		const second = await admin.provisionTenant(provision("carol", "Carol", now, "cDI="));
		expect(second.ok).toBe(true);
		expect(second.nonce).not.toBe(first.nonce);
		expect(store.loadDomain("carol")?.pendingTenant?.nonce).toBe(second.nonce);
	});
});

describe("TenantAdmin set_display_name", () => {
	function rename(
		domainId: string,
		displayName: string,
		owner: ReturnType<typeof generateIdentity>,
		at = now,
		nonce = "cmVuYW1l",
	) {
		const r: SetDisplayName = { domainId, displayName, issuedAt: at, nonce };
		return signSetDisplayName(r, owner.sign.priv, owner.sign.pub);
	}

	it("renames a rooted Domain when owner-signed by ITS owner", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol", "Carol"));
		const friend = generateIdentity();
		await admin.firstRoot(firstRoot("carol", friend, p.nonce as string));
		const res = await admin.setDisplayName(rename("carol", "Carol's Lab", friend));
		expect(res.ok).toBe(true);
		expect(res.displayName).toBe("Carol's Lab");
		expect(store.loadDomain("carol")?.displayName).toBe("Carol's Lab");
	});

	it("rejects a rename signed by a key that is NOT the Domain's owner", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol", "Carol"));
		const friend = generateIdentity();
		await admin.firstRoot(firstRoot("carol", friend, p.nonce as string));
		const res = await admin.setDisplayName(rename("carol", "Hijacked", adminOwner));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not owner-signed/);
		expect(store.loadDomain("carol")?.displayName).toBe("Carol");
	});

	it("rejects a rename of an unrooted (pending) Domain", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await admin.provisionTenant(provision("carol", "Carol"));
		const friend = generateIdentity();
		const res = await admin.setDisplayName(rename("carol", "Too Soon", friend));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not rooted/);
	});

	it("rejects a replayed rename (same op nonce)", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol", "Carol"));
		const friend = generateIdentity();
		await admin.firstRoot(firstRoot("carol", friend, p.nonce as string));
		const signed = rename("carol", "Carol's Lab", friend);
		expect((await admin.setDisplayName(signed)).ok).toBe(true);
		const replay = await admin.setDisplayName(signed);
		expect(replay.ok).toBe(false);
		expect(replay.error).toMatch(/replayed/);
	});
});
