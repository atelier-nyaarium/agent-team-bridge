import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../arbiter/federation/allowlist.js";
import { ReplayGuard } from "../arbiter/federation/replayGuard.js";
import { createSealer } from "../arbiter/federation/sealer.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "sealer-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const owner = generateIdentity();
const A = generateIdentity();
const B = generateIdentity();

function hostAdmission(hostId: string, id: { sign: { pub: string }; box: { pub: string } }): Admission {
	return { kind: "host", signPub: id.sign.pub, boxPub: id.box.pub, hostId, issuedAt: 1, nonce: "bg==" };
}

/** An allowlist rooted at `owner` admitting both Host A and Host B. */
function allowlistWithBoth(): Allowlist {
	const a = new Allowlist(tmp());
	a.setOwner(owner.sign.pub);
	a.addAdmission(signAdmission(hostAdmission("A", A), owner.sign.priv, owner.sign.pub));
	a.addAdmission(signAdmission(hostAdmission("B", B), owner.sign.priv, owner.sign.pub));
	return a;
}

describe("sealer", () => {
	it("round-trips a sealed object between two admitted Hosts", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		const bSealer = createSealer(B, allowlistWithBoth(), "B");
		const env = aSealer.seal("B", { hello: "world", n: 7 });
		expect(bSealer.open("A", env)).toEqual({ hello: "world", n: 7 });
	});

	it("rejects a replayed envelope (same nonce opened twice)", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		const bSealer = createSealer(B, allowlistWithBoth(), "B");
		const env = aSealer.seal("B", { n: 1 });
		expect(bSealer.open("A", env)).toEqual({ n: 1 });
		expect(() => bSealer.open("A", env)).toThrow(/replay/);
	});

	it("rejects an envelope naming an unadmitted source Host", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		const bSealer = createSealer(B, allowlistWithBoth(), "B");
		const env = aSealer.seal("B", { x: 1 });
		expect(() => bSealer.open("C", env)).toThrow(/not admitted/);
	});

	it("fails to open a tampered envelope", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		const bSealer = createSealer(B, allowlistWithBoth(), "B");
		const env = aSealer.seal("B", { ok: true });
		const tampered = { ...env, ciphertext: Buffer.from("evil").toString("base64") };
		expect(() => bSealer.open("A", tampered)).toThrow();
	});

	it("rejects a relabeled source (signed-in src must match the claimed srcHost)", () => {
		// A seals to B, but evie relabels the frame as if it came from a third admitted
		// Host. The signature verifies under A's key only if open() is told srcHost=A;
		// told srcHost=B it fails to verify, told the truth it fails the src cross-check
		// when the cleartext label is forged. Here the label disagrees with the seal.
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		const bSealer = createSealer(B, allowlistWithBoth(), "B");
		const env = aSealer.seal("B", { x: 1 });
		// B is also admitted; opening A's frame under label "B" must not verify/attribute.
		expect(() => bSealer.open("B", env)).toThrow();
	});

	it("rejects a frame addressed to a different Host", () => {
		const aSealer = createSealer(A, allowlistWithBoth(), "A");
		// A seals to B, but a Host that believes itself "C" opens it.
		const cSealer = createSealer(B, allowlistWithBoth(), "C");
		const env = aSealer.seal("B", { x: 1 });
		expect(() => cSealer.open("A", env)).toThrow(/not addressed to this Host/);
	});

	it("rejects a stale envelope past the freshness window", () => {
		let clock = 1_000_000;
		const aSealer = createSealer(A, allowlistWithBoth(), "A", new ReplayGuard(), () => clock);
		const bSealer = createSealer(B, allowlistWithBoth(), "B", new ReplayGuard(), () => clock);
		const env = aSealer.seal("B", { x: 1 });
		clock += 120_001; // past SEAL_MAX_AGE_MS
		expect(() => bSealer.open("A", env)).toThrow(/stale/);
	});
});
