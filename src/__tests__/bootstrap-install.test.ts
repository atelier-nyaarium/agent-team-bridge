import { describe, expect, it } from "vitest";
import { openBootstrapBundle } from "../arbiter/federation/bootstrapInstall.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { generateIdentity, type Identity, seal } from "../shared/crypto.js";

function buildFrame(
	owner: Identity,
	sw: Identity,
	console_: Identity,
	nonce: string,
	switchId: string,
	admissionSigner: Identity = owner,
): unknown {
	const admission: Admission = {
		kind: "switch",
		signPub: sw.sign.pub,
		boxPub: sw.box.pub,
		switchId,
		issuedAt: 1000,
		nonce: "adm",
	};
	const signed = signAdmission(admission, admissionSigner.sign.priv, admissionSigner.sign.pub);
	const bundle = {
		nonce,
		transport: { apiUrl: "https://api", saToken: "sa", caPem: "ca", appToken: "app" },
		admission: signed,
		domain: { ownerSignPub: owner.sign.pub, admissions: [signed], revocations: [] },
	};
	const sealed = seal(Buffer.from(JSON.stringify(bundle), "utf8"), sw.box.pub, console_.sign.priv);
	return { v: 1, signerSignPub: console_.sign.pub, sealed };
}

describe("openBootstrapBundle", () => {
	const owner = generateIdentity();
	const sw = generateIdentity();
	const console_ = generateIdentity();

	it("opens a valid bundle sealed to this Switch", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		const bundle = openBootstrapBundle(frame, sw, "n1", "sakura");
		expect(bundle.transport.apiUrl).toBe("https://api");
		expect(bundle.domain.ownerSignPub).toBe(owner.sign.pub);
	});

	it("rejects a nonce from a different enrollment window", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(() => openBootstrapBundle(frame, sw, "n2", "sakura")).toThrow();
	});

	it("rejects an admission signed by a non-owner key", () => {
		const attacker = generateIdentity();
		const frame = buildFrame(owner, sw, console_, "n1", "sakura", attacker);
		expect(() => openBootstrapBundle(frame, sw, "n1", "sakura")).toThrow();
	});

	it("rejects delivery to the wrong Switch (cannot decrypt)", () => {
		const other = generateIdentity();
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(() => openBootstrapBundle(frame, other, "n1", "sakura")).toThrow();
	});

	it("rejects an admission bound to a different Switch id", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(() => openBootstrapBundle(frame, sw, "n1", "willow")).toThrow();
	});
});
