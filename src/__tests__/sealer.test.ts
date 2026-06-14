import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Allowlist } from "../arbiter/federation/allowlist.js";
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
		const aSealer = createSealer(A, allowlistWithBoth());
		const bSealer = createSealer(B, allowlistWithBoth());
		const env = aSealer.seal("B", { hello: "world", n: 7 });
		expect(bSealer.open("A", env)).toEqual({ hello: "world", n: 7 });
	});

	it("rejects a replayed envelope (same nonce opened twice)", () => {
		const aSealer = createSealer(A, allowlistWithBoth());
		const bSealer = createSealer(B, allowlistWithBoth());
		const env = aSealer.seal("B", { n: 1 });
		expect(bSealer.open("A", env)).toEqual({ n: 1 });
		expect(() => bSealer.open("A", env)).toThrow(/replay/);
	});

	it("rejects an envelope naming an unadmitted source Host", () => {
		const aSealer = createSealer(A, allowlistWithBoth());
		const bSealer = createSealer(B, allowlistWithBoth());
		const env = aSealer.seal("B", { x: 1 });
		expect(() => bSealer.open("C", env)).toThrow(/not admitted/);
	});

	it("fails to open a tampered envelope", () => {
		const aSealer = createSealer(A, allowlistWithBoth());
		const bSealer = createSealer(B, allowlistWithBoth());
		const env = aSealer.seal("B", { ok: true });
		const tampered = { ...env, ciphertext: Buffer.from("evil").toString("base64") };
		expect(() => bSealer.open("A", tampered)).toThrow();
	});
});
