import { describe, expect, it } from "vitest";
import type { EnrollmentState, FederationSecret } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import type { SecretIO } from "../federation-server/secretIO.js";
import { TenantAdmin } from "../federation-server/tenantAdmin.js";
import { generateIdentity } from "../shared/crypto.js";
import { signFirstRoot } from "../shared/federation-lifecycle.js";
import { adminOwner, firstRoot, freshStore, now, provision, removal } from "./helpers/tenant-admin.js";

describe("TenantAdmin first_root (atomic one-time redemption, G2)", () => {
	it("roots a pending Domain at the friend's key on a valid invite", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		const res = await admin.firstRoot(firstRoot("carol", friend, p.nonce as string));
		expect(res.ok).toBe(true);
		const slice = store.loadDomain("carol");
		expect(slice?.ownerSignPub).toBe(friend.sign.pub);
		expect(slice?.ownerBoxPub).toBe(friend.box.pub);
		expect(slice?.pendingTenant?.rooted).toBe(true);
	});

	it("rejects a first_root with the wrong invite nonce", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		const res = await admin.firstRoot(firstRoot("carol", friend, "d3Jvbmctbm9uY2U="));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/invalid or expired invite/);
		expect(store.loadDomain("carol")?.ownerSignPub).toBeNull();
	});

	it("rejects a first_root whose self-signature does not verify", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		const tampered = firstRoot("carol", friend, p.nonce as string);
		const other = generateIdentity();
		tampered.signature = signFirstRoot(
			{ ...tampered.firstRoot, ownerSignPub: other.sign.pub },
			other.sign.priv,
		).signature;
		const res = await admin.firstRoot(tampered);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/self-signed/);
	});

	it("is idempotent on the SAME key, refuses a re-root at a DIFFERENT key", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const p = await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		const nonce = p.nonce as string;
		expect((await admin.firstRoot(firstRoot("carol", friend, nonce))).ok).toBe(true);
		const again = await admin.firstRoot(firstRoot("carol", friend, nonce));
		expect(again.ok).toBe(true);
		const intruder = generateIdentity();
		const stolen = await admin.firstRoot(firstRoot("carol", intruder, nonce));
		expect(stolen.ok).toBe(false);
		expect(stolen.error).toMatch(/invalid or expired invite/);
		expect(store.loadDomain("carol")?.ownerSignPub).toBe(friend.sign.pub);
	});

	it("rejects a first_root with no pending tenant", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const friend = generateIdentity();
		const res = await admin.firstRoot(firstRoot("never-staged", friend, "c29tZS1ub25jZQ=="));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/invalid or expired invite/);
	});

	it("enforces the invite TTL server-side (issuedAt + ttlMs vs the Router's clock)", async () => {
		const store = await freshStore();
		let clock = now;
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => clock,
			1_000,
		);
		const p = await admin.provisionTenant(provision("carol"));
		const friend = generateIdentity();
		clock = now + 5_000; // past the 1s invite ttl (but the first_root op's own issuedAt is fresh)
		const res = await admin.firstRoot(firstRoot("carol", friend, p.nonce as string, clock));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/expired/);
		expect(store.loadDomain("carol")?.ownerSignPub).toBeNull();
	});

	it("two concurrent redeemers: first-to-root wins, the loser gets the opaque reject", async () => {
		const friendA = generateIdentity();
		const friendB = generateIdentity();
		const identity = generateIdentity();
		const pendingSlice: EnrollmentState = {
			ownerSignPub: null,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
			displayName: "Carol",
			pendingTenant: { displayName: "Carol", nonce: "aW52aXRl", issuedAt: now, ttlMs: 60_000, rooted: false },
		};
		let version = 1;
		let stored: FederationSecret = { schema: 2, identity, enrollment: { carol: pendingSlice } };
		let firstWrite = true;
		const io: SecretIO = {
			read: async () => ({ value: stored, resourceVersion: String(version) }),
			write: async (v, _rv) => {
				if (firstWrite) {
					firstWrite = false;
					stored = {
						schema: 2,
						identity,
						enrollment: {
							carol: {
								...pendingSlice,
								ownerSignPub: friendA.sign.pub,
								ownerBoxPub: friendA.box.pub,
								pendingTenant: { ...pendingSlice.pendingTenant!, rooted: true },
							},
						},
					};
					version += 1;
					const { ConflictError } = await import("../federation-server/secretIO.js");
					throw new ConflictError("concurrent root won the resourceVersion");
				}
				stored = v;
				version += 1;
			},
		};
		const store = new FileSecretStore("/tmp", io);
		await store.init();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.firstRoot(firstRoot("carol", friendB, "aW52aXRl"));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/invalid or expired invite/);
		expect(stored.enrollment.carol.ownerSignPub).toBe(friendA.sign.pub);
	});

	it("a wrong-nonce probe returns the IDENTICAL opaque reject for absent / pending / rooted", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const rootedFriend = generateIdentity();
		const pr = await admin.provisionTenant(provision("rooted-dom"));
		expect((await admin.firstRoot(firstRoot("rooted-dom", rootedFriend, pr.nonce as string))).ok).toBe(true);
		await admin.provisionTenant(provision("pending-dom")); // pending, never rooted

		const wrongNonce = "d3JvbmctcHJvYmU=";
		const prober = generateIdentity();
		const onRooted = await admin.firstRoot(firstRoot("rooted-dom", prober, wrongNonce));
		const onPending = await admin.firstRoot(firstRoot("pending-dom", prober, wrongNonce));
		const onAbsent = await admin.firstRoot(firstRoot("absent-dom", prober, wrongNonce));

		expect(onRooted.ok).toBe(false);
		expect(onPending.ok).toBe(false);
		expect(onAbsent.ok).toBe(false);
		expect(onRooted.error).toBe("invalid or expired invite");
		expect(onPending.error).toBe(onRooted.error);
		expect(onAbsent.error).toBe(onRooted.error);

		const pendingFriend = generateIdentity();
		const pendingNonce = store.loadDomain("pending-dom")?.pendingTenant?.nonce as string;
		expect((await admin.firstRoot(firstRoot("pending-dom", pendingFriend, pendingNonce))).ok).toBe(true);
		expect((await admin.firstRoot(firstRoot("pending-dom", pendingFriend, pendingNonce))).ok).toBe(true);

		let clock = now;
		const ttlAdmin = new TenantAdmin(
			await freshStore(),
			() => adminOwner.sign.pub,
			() => clock,
			1_000,
		);
		const expFriend = generateIdentity();
		const ep = await ttlAdmin.provisionTenant(provision("dave"));
		clock = now + 5_000; // past the 1s invite ttl
		const expired = await ttlAdmin.firstRoot(firstRoot("dave", expFriend, ep.nonce as string, clock));
		expect(expired.ok).toBe(false);
		expect(expired.error).toMatch(/expired/);
	});
});

describe("TenantAdmin first_root on the admin Domain (the admin's own)", () => {
	async function seedPendingAdminDomain(store: FileSecretStore, inviteNonce: string) {
		const pending: EnrollmentState = {
			ownerSignPub: null,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
			displayName: "Nyaarium",
			pendingTenant: {
				displayName: "Nyaarium",
				nonce: inviteNonce,
				issuedAt: now,
				ttlMs: 60_000,
				rooted: false,
			},
			isAdminDomain: true,
		};
		store.saveDomain("alice", pending);
		await store.flushDomain("alice");
	}

	it("first-roots a PENDING admin Domain at the admin's key on a valid invite nonce", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await seedPendingAdminDomain(store, "aG9tZS1pbnZpdGU=");
		const phone = generateIdentity();
		const res = await admin.firstRoot(firstRoot("alice", phone, "aG9tZS1pbnZpdGU="));
		expect(res.ok).toBe(true);
		const slice = store.loadDomain("alice");
		expect(slice?.ownerSignPub).toBe(phone.sign.pub);
		expect(slice?.ownerBoxPub).toBe(phone.box.pub);
		expect(slice?.pendingTenant?.rooted).toBe(true);
	});

	it("an ALREADY-ROOTED admin Domain is idempotent on the SAME key, opaque-rejects a DIFFERENT key", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await seedPendingAdminDomain(store, "aG9tZS1pbnZpdGU=");
		const phone = generateIdentity();
		expect((await admin.firstRoot(firstRoot("alice", phone, "aG9tZS1pbnZpdGU="))).ok).toBe(true);
		const again = await admin.firstRoot(firstRoot("alice", phone, "aG9tZS1pbnZpdGU="));
		expect(again.ok).toBe(true);
		const intruder = generateIdentity();
		const stolen = await admin.firstRoot(firstRoot("alice", intruder, "aG9tZS1pbnZpdGU="));
		expect(stolen.ok).toBe(false);
		expect(stolen.error).toMatch(/invalid or expired invite/);
		expect(store.loadDomain("alice")?.ownerSignPub).toBe(phone.sign.pub);
	});

	it("provision_tenant still REFUSES the admin Domain", async () => {
		const store = await freshStore();
		await seedPendingAdminDomain(store, "aG9tZS1pbnZpdGU=");
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const res = await admin.provisionTenant(provision("alice"));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/the admin's Domain/);
	});

	it("remove_tenant still REFUSES the admin Domain", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		await seedPendingAdminDomain(store, "aG9tZS1pbnZpdGU=");
		const res = await admin.removeTenant(removal("alice"));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/the admin's Domain/);
		expect(store.loadDomain("alice")).not.toBeNull();
	});
});

describe("TenantAdmin firstRoot preserves the adminOwner marker", () => {
	it("a staged primary admin Domain stays primary after the phone first-roots it", async () => {
		const store = await freshStore();
		const admin = new TenantAdmin(
			store,
			() => adminOwner.sign.pub,
			() => now,
		);
		const friend = generateIdentity();
		const nonce = "aG9tZW5vbmNl";
		store.saveDomain("a1b2c3d4", {
			ownerSignPub: null,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
			displayName: "Nyaarium",
			pendingTenant: { displayName: "Nyaarium", nonce, issuedAt: now, ttlMs: 600_000, rooted: false },
			isAdminDomain: true,
		});
		await new Promise((r) => setTimeout(r, 10));

		const res = await admin.firstRoot(firstRoot("a1b2c3d4", friend, nonce));
		expect(res.ok).toBe(true);

		const slice = store.loadDomain("a1b2c3d4");
		expect(slice?.ownerSignPub).toBe(friend.sign.pub);
		expect(slice?.isAdminDomain).toBe(true);
		expect(store.adminDomainId()).toBe("a1b2c3d4");
	});

	it("refuses to provision or remove the primary admin Domain at a non-default id", async () => {
		const store = await freshStore();
		store.saveDomain("a1b2c3d4", {
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
		const prov = await admin.provisionTenant(provision("a1b2c3d4"));
		expect(prov.ok).toBe(false);
		expect(prov.error).toMatch(/the admin's Domain/);
		const rem = await admin.removeTenant(removal("a1b2c3d4"));
		expect(rem.ok).toBe(false);
		expect(rem.error).toMatch(/the admin's Domain/);
	});
});
