import { describe, expect, it } from "vitest";
import {
	clearActiveEnrollment,
	dispatchEnrollOp,
	EnrollmentCoordinator,
	getEnrollmentForDomain,
	inMemoryEnrollmentStore,
	resolveEnrollRoute,
	sanitizeDomainId,
	setActiveEnrollment,
	shouldVivifyCoordinator,
} from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState, FederationSecret } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import type { SecretIO } from "../federation-server/secretIO.js";
import { signAdmission, signRevocation } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { signXDomainLinkEdge } from "../shared/federation-lifecycle.js";

const evie = generateIdentity();
const now = 1_000_000;

function fakeMultiDomainIO(): SecretIO {
	let stored: FederationSecret | null = null;
	let version = 0;
	return {
		read: async () => (stored ? { value: stored, resourceVersion: String(version) } : null),
		write: async (v) => {
			stored = v;
			version += 1;
		},
	};
}

function coordinator(initial?: EnrollmentState) {
	return new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(initial), "alice");
}

describe("resolveEnrollRoute (multi-tenant owner-fact routing)", () => {
	const adminOwner = generateIdentity();
	const guestOwner = generateIdentity();
	const deps = {
		adminDomainId: "admin-dom",
		rootedDomainFor: (key: string) =>
			key === adminOwner.sign.pub ? "admin-dom" : key === guestOwner.sign.pub ? "guest-dom" : null,
	};

	function gatewayAdmission(signer: ReturnType<typeof generateIdentity>) {
		const subject = generateIdentity();
		return signAdmission(
			{
				kind: "gateway" as const,
				signPub: subject.sign.pub,
				boxPub: subject.box.pub,
				gatewayId: "laptop",
				issuedAt: 1000,
				nonce: "bm9uY2U=",
			},
			signer.sign.priv,
			signer.sign.pub,
		);
	}

	it("routes an admission to the Domain its signer roots, never an assumed admin Domain", () => {
		const guest = gatewayAdmission(guestOwner);
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: guest }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const admin = gatewayAdmission(adminOwner);
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: admin }, deps)).toEqual({
			kind: "domain",
			domainId: "admin-dom",
		});
	});

	it("a signer rooting no Domain is refused with the same wording as a bad signature", () => {
		const stranger = gatewayAdmission(generateIdentity());
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: stranger }, deps)).toEqual({
			kind: "refused",
			error: "admission not owner-signed",
		});
		const revocation = signRevocation(
			{ signPub: generateIdentity().sign.pub, issuedAt: 1000, nonce: "bm9uY2U=" },
			guestOwner.sign.priv,
			guestOwner.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_revocation", revocation }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const strangerId = generateIdentity();
		const strangerRevocation = signRevocation(
			{ signPub: generateIdentity().sign.pub, issuedAt: 1000, nonce: "bm9uY2U=" },
			strangerId.sign.priv,
			strangerId.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_revocation", revocation: strangerRevocation }, deps)).toEqual({
			kind: "refused",
			error: "revocation not owner-signed",
		});
	});

	it("link edges route by srcDomainId, tenant ops by admin Domain, delete_domain to the tenant authority", () => {
		const edge = signXDomainLinkEdge(
			{ srcDomainId: "guest-dom", dstDomainId: "admin-dom", issuedAt: 1000, nonce: "bm9uY2U=" },
			guestOwner.sign.priv,
			guestOwner.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_xdomain_link", edge }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const rename = { kind: "set_display_name" as const, rename: {} as never };
		expect(resolveEnrollRoute(rename, deps)).toEqual({ kind: "domain", domainId: "admin-dom" });
		expect(resolveEnrollRoute(rename, { ...deps, adminDomainId: null })).toEqual({
			kind: "refused",
			error: "no admin Domain",
		});
		expect(resolveEnrollRoute({ kind: "delete_domain", deletion: {} as never }, deps)).toEqual({
			kind: "tenant-authority",
		});
	});

	it("a guest admission lands in the guest coordinator; the admin coordinator (the old routing) rejects it", () => {
		const adminC = new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(), "admin-dom");
		const pa = adminC.mintEnrollOwner("admin-dom", "https://evie", now);
		adminC.redeemEnrollOwner(pa.nonce, adminOwner.sign.pub, adminOwner.box.pub, now);
		const guestC = new EnrollmentCoordinator(evie, inMemoryEnrollmentStore(), "guest-dom");
		const pg = guestC.mintEnrollOwner("guest-dom", "https://evie", now);
		guestC.redeemEnrollOwner(pg.nonce, guestOwner.sign.pub, guestOwner.box.pub, now);

		const op = { kind: "submit_admission" as const, admission: gatewayAdmission(guestOwner) };
		const route = resolveEnrollRoute(op, deps);
		expect(route).toEqual({ kind: "domain", domainId: "guest-dom" });
		expect(dispatchEnrollOp(guestC, op)).toEqual({ ok: true });
		expect(guestC.getDomainSnapshot()?.admissions).toHaveLength(1);
		expect(dispatchEnrollOp(adminC, op)).toEqual({ ok: false, error: "admission not owner-signed" });
	});
});

describe("EnrollmentCoordinator active-coordinator registry (multi-tenant)", () => {
	it("setActiveEnrollment keys by domainId; getEnrollmentForDomain resolves per Domain", () => {
		clearActiveEnrollment();
		const admin = coordinator();
		const work = coordinator();
		setActiveEnrollment("alice", admin);
		setActiveEnrollment("work", work);
		expect(getEnrollmentForDomain("alice")).toBe(admin);
		expect(getEnrollmentForDomain("work")).toBe(work);
		expect(getEnrollmentForDomain("absent")).toBeNull();
		setActiveEnrollment("alice", null);
		expect(getEnrollmentForDomain("alice")).toBeNull();
		expect(getEnrollmentForDomain("work")).toBe(work);
		clearActiveEnrollment();
		expect(getEnrollmentForDomain("work")).toBeNull();
	});
});

describe("EnrollmentCoordinator domain isolation over one store", () => {
	it("two Domains over distinct store slices root at independent owners + persist apart", async () => {
		const io = fakeMultiDomainIO();
		const store = new FileSecretStore("/tmp", io);
		await store.init();
		const ownerAdmin = generateIdentity();
		const ownerWork = generateIdentity();
		const admin = new EnrollmentCoordinator(evie, store.domainStore("alice"), "alice");
		const work = new EnrollmentCoordinator(evie, store.domainStore("work"), "work");
		const ph = admin.mintEnrollOwner("alice", "https://evie", now);
		admin.redeemEnrollOwner(ph.nonce, ownerAdmin.sign.pub, ownerAdmin.box.pub, now);
		const pw = work.mintEnrollOwner("work", "https://evie", now);
		work.redeemEnrollOwner(pw.nonce, ownerWork.sign.pub, ownerWork.box.pub, now);
		expect(admin.getDomainSnapshot()?.ownerSignPub).toBe(ownerAdmin.sign.pub);
		expect(work.getDomainSnapshot()?.ownerSignPub).toBe(ownerWork.sign.pub);
		expect(admin.getDomainSnapshot()?.ownerSignPub).not.toBe(work.getDomainSnapshot()?.ownerSignPub);
		await new Promise((r) => setTimeout(r, 20));
		const reloaded = new FileSecretStore("/tmp", io);
		await reloaded.init();
		expect(reloaded.loadDomain("alice")?.ownerSignPub).toBe(ownerAdmin.sign.pub);
		expect(reloaded.loadDomain("work")?.ownerSignPub).toBe(ownerWork.sign.pub);
	});
});

describe("sanitizeDomainId (red-team P3)", () => {
	it("slugs to lower-case alphanumerics with single dashes", () => {
		expect(sanitizeDomainId("My Lab")).toBe("my-lab");
		expect(sanitizeDomainId("ACME_Corp.1")).toBe("acme-corp-1");
	});

	it("trims dash runs and collapses the qualifier separator", () => {
		expect(sanitizeDomainId("--alice--")).toBe("alice");
		expect(sanitizeDomainId("a/b")).toBe("a-b");
	});

	it("throws on empty / all-separator / nullish input (no silent fallback)", () => {
		expect(() => sanitizeDomainId("")).toThrow();
		expect(() => sanitizeDomainId("///")).toThrow();
		expect(() => sanitizeDomainId(undefined)).toThrow();
		expect(() => sanitizeDomainId(null)).toThrow();
	});
});

describe("shouldVivifyCoordinator (red-team P3: unbounded coordinators)", () => {
	const rooted: EnrollmentState = { ownerSignPub: "owner", ownerBoxPub: "box", admissions: [], revocations: [] };
	const unrooted: EnrollmentState = { ownerSignPub: null, ownerBoxPub: null, admissions: [], revocations: [] };

	it("does not vivify a Domain with no state (no default pre-create)", () => {
		expect(shouldVivifyCoordinator("alice", null)).toBe(false);
	});

	it("does NOT mint a coordinator for an unknown, never-rooted Domain", () => {
		expect(shouldVivifyCoordinator("random-guest-domain", null)).toBe(false);
		expect(shouldVivifyCoordinator("random-guest-domain", unrooted)).toBe(false);
	});

	it("mints a non-admin Domain only once it carries rooted state (admin rooted it)", () => {
		expect(shouldVivifyCoordinator("work", rooted)).toBe(true);
	});

	it("mints a PENDING (admin-staged, unrooted) Domain so a friend can reach it", () => {
		const pending: EnrollmentState = {
			ownerSignPub: null,
			ownerBoxPub: null,
			admissions: [],
			revocations: [],
			pendingTenant: { displayName: "Carol", nonce: "aW52aXRl", issuedAt: 1, ttlMs: 60_000, rooted: false },
		};
		expect(shouldVivifyCoordinator("carol", pending)).toBe(true);
	});
});
