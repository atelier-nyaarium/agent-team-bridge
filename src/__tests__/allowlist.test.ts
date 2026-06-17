import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../arbiter/federation/allowlist.js";
import { type Admission, signAdmission, signRevocation } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const dirs: string[] = [];
function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "fed-allow-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const owner = generateIdentity();
const host = generateIdentity();
function hostAdmission(over: Partial<Admission> = {}): Admission {
	return {
		kind: "host",
		signPub: host.sign.pub,
		boxPub: host.box.pub,
		hostId: "laptop",
		issuedAt: 1000,
		nonce: "bg==",
		...over,
	};
}

describe("Allowlist", () => {
	it("rejects an admission before the owner is set", () => {
		const a = new Allowlist(tmpDir());
		expect(a.addAdmission(signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub))).toBe(false);
	});

	it("admits a Host and resolves it by id and by key", () => {
		const a = new Allowlist(tmpDir());
		a.setOwner(owner.sign.pub);
		expect(a.addAdmission(signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub))).toBe(true);
		expect(a.resolveHost("laptop")).toEqual({ signPub: host.sign.pub, boxPub: host.box.pub });
		expect(a.resolveBySignPub(host.sign.pub)?.hostId).toBe("laptop");
		expect(a.resolveHost("desktop")).toBeNull();
	});

	it("rejects an admission forged by a non-owner", () => {
		const a = new Allowlist(tmpDir());
		a.setOwner(owner.sign.pub);
		const attacker = generateIdentity();
		expect(a.addAdmission(signAdmission(hostAdmission(), attacker.sign.priv, attacker.sign.pub))).toBe(false);
		expect(a.resolveHost("laptop")).toBeNull();
	});

	it("refuses to re-root at a different owner", () => {
		const a = new Allowlist(tmpDir());
		a.setOwner(owner.sign.pub);
		const other = generateIdentity();
		expect(() => a.setOwner(other.sign.pub)).toThrow(/different owner/);
	});

	it("a revocation removes the Host from resolution", () => {
		const a = new Allowlist(tmpDir());
		a.setOwner(owner.sign.pub);
		a.addAdmission(signAdmission(hostAdmission({ issuedAt: 1000 }), owner.sign.priv, owner.sign.pub));
		a.addRevocation(
			signRevocation({ signPub: host.sign.pub, issuedAt: 2000, nonce: "cg==" }, owner.sign.priv, owner.sign.pub),
		);
		expect(a.resolveHost("laptop")).toBeNull();
		expect(a.resolveBySignPub(host.sign.pub)).toBeNull();
	});

	it("persists across reloads", () => {
		const dir = tmpDir();
		const a = new Allowlist(dir);
		a.setOwner(owner.sign.pub);
		a.addAdmission(signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub));
		// A fresh instance reads the same file.
		const b = new Allowlist(dir);
		expect(b.ownerSignPub).toBe(owner.sign.pub);
		expect(b.resolveHost("laptop")?.boxPub).toBe(host.box.pub);
	});

	it("mirrors a Domain snapshot and surfaces the arbiter's own admission", () => {
		const a = new Allowlist(tmpDir());
		a.applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub)],
			revocations: [],
		});
		expect(a.ownerSignPub).toBe(owner.sign.pub);
		expect(a.resolveHost("laptop")?.boxPub).toBe(host.box.pub);
		expect(a.selfAdmission(host.sign.pub)?.admission.hostId).toBe("laptop");
	});

	it("applySnapshot is idempotent and drops non-owner entries", () => {
		const a = new Allowlist(tmpDir());
		const attacker = generateIdentity();
		const snapshot = {
			ownerSignPub: owner.sign.pub,
			admissions: [
				signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub),
				// A forged admission in the sync is filtered out, not stored.
				signAdmission(hostAdmission({ hostId: "evil" }), attacker.sign.priv, attacker.sign.pub),
			],
			revocations: [],
		};
		a.applySnapshot(snapshot);
		a.applySnapshot(snapshot);
		// Re-sync converged (no duplicate), and the forged "evil" admission never landed.
		expect(a.resolveHost("evil")).toBeNull();
		expect(a.resolveHost("laptop")?.boxPub).toBe(host.box.pub);
	});

	it("ignores a snapshot rooted at a different owner", () => {
		const a = new Allowlist(tmpDir());
		a.setOwner(owner.sign.pub);
		const other = generateIdentity();
		a.applySnapshot({ ownerSignPub: other.sign.pub, admissions: [], revocations: [] });
		// The original root stands; the foreign snapshot is ignored.
		expect(a.ownerSignPub).toBe(owner.sign.pub);
	});

	it("refuses to root at a non-pinned owner (untrusted-evie defense)", () => {
		// A malicious evie relays a snapshot rooting a fresh Host at an attacker key.
		const attacker = generateIdentity();
		const a = new Allowlist(tmpDir(), owner.sign.pub);
		a.applySnapshot({
			ownerSignPub: attacker.sign.pub,
			admissions: [signAdmission(hostAdmission(), attacker.sign.priv, attacker.sign.pub)],
			revocations: [],
		});
		// The pinned owner did not sign this; the Host stays unrooted.
		expect(a.ownerSignPub).toBeNull();
		expect(a.resolveHost("laptop")).toBeNull();
	});

	it("adopts a snapshot that matches the pinned owner", () => {
		const a = new Allowlist(tmpDir(), owner.sign.pub);
		a.applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub)],
			revocations: [],
		});
		expect(a.ownerSignPub).toBe(owner.sign.pub);
		expect(a.resolveHost("laptop")?.boxPub).toBe(host.box.pub);
	});

	it("clears a persisted root that disagrees with a newly-set pin", () => {
		const dir = tmpDir();
		const first = new Allowlist(dir);
		first.applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub)],
			revocations: [],
		});
		// Re-open pinned to a DIFFERENT owner: the stale root is dropped, not served.
		const other = generateIdentity();
		const reopened = new Allowlist(dir, other.sign.pub);
		expect(reopened.ownerSignPub).toBeNull();
	});

	it("strict mode without a pin refuses to root from a snapshot (no trust-on-first-use)", () => {
		// requireOwnerPin = true, but FEDERATION_OWNER_SIGN_PUB unset: the Host must
		// not trust the first owner key evie relays.
		const a = new Allowlist(tmpDir(), null, true);
		a.applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub)],
			revocations: [],
		});
		expect(a.ownerSignPub).toBeNull();
		expect(a.resolveHost("laptop")).toBeNull();
	});

	it("strict mode without a pin refuses setOwner", () => {
		const a = new Allowlist(tmpDir(), null, true);
		expect(() => a.setOwner(owner.sign.pub)).toThrow(/REQUIRE_OWNER_PIN/);
	});

	it("strict mode WITH a matching pin still roots normally", () => {
		const a = new Allowlist(tmpDir(), owner.sign.pub, true);
		a.applySnapshot({
			ownerSignPub: owner.sign.pub,
			admissions: [signAdmission(hostAdmission(), owner.sign.priv, owner.sign.pub)],
			revocations: [],
		});
		expect(a.ownerSignPub).toBe(owner.sign.pub);
		expect(a.resolveHost("laptop")?.boxPub).toBe(host.box.pub);
	});
});
