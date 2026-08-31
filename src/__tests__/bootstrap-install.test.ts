import { describe, expect, it } from "vitest";
import { openBootstrapBundle } from "../gateway/federation/bootstrapInstall.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { generateIdentity, type Identity, seal } from "../shared/crypto.js";

function buildFrame(
	owner: Identity,
	sw: Identity,
	console_: Identity,
	nonce: string,
	gatewayId: string,
	admissionSigner: Identity = owner,
): unknown {
	const admission: Admission = {
		kind: "gateway",
		signPub: sw.sign.pub,
		boxPub: sw.box.pub,
		gatewayId,
		issuedAt: 1000,
		nonce: "adm",
	};
	const signed = signAdmission(admission, admissionSigner.sign.priv, admissionSigner.sign.pub);
	// Realistic field lengths, so the size assertion below measures a real bundle rather than a toy:
	// a 64-hex fingerprint and a 64-hex bearer are what the Router actually hands out.
	const transport = {
		routerUrl: "https://switchboard.example.com:20001",
		routerCertFp: "ce".repeat(32),
		bearer: "ab".repeat(32),
	};
	const bundle = {
		nonce,
		transport,
		admission: signed,
		domain: { ownerSignPub: owner.sign.pub, admissions: [signed], revocations: [] },
		domainId: "a95dd4e979aa3be5",
	};
	const sealed = seal(Buffer.from(JSON.stringify(bundle), "utf8"), sw.box.pub, console_.sign.priv);
	return { v: 1, signerSignPub: console_.sign.pub, sealed };
}

describe("openBootstrapBundle", () => {
	const owner = generateIdentity();
	const sw = generateIdentity();
	const console_ = generateIdentity();

	it("opens a valid bundle sealed to this Gateway", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		const bundle = openBootstrapBundle(frame, sw, "n1", "sakura");
		expect(bundle.transport.routerUrl).toBe("https://switchboard.example.com:20001");
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

	it("rejects delivery to the wrong Gateway (cannot decrypt)", () => {
		const other = generateIdentity();
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(() => openBootstrapBundle(frame, other, "n1", "sakura")).toThrow();
	});

	it("rejects an admission bound to a different Gateway id", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(() => openBootstrapBundle(frame, sw, "n1", "willow")).toThrow();
	});

	// The bundle carries the root and the Gateway's OWN admission, nothing else - the roster and the
	// revocations arrive on the register reply, verified against that same root. This pins that a
	// minimal bundle is enough to install, and that its sealed frame fits a terminal paste with room:
	// a bundle carrying the whole roster grew ~370 bytes per member and crossed the 4096-byte line the
	// tty discards past, which is how paste enrollment broke on the first machine that was not the first.
	it("installs from a bundle that names only the root and its own admission, and that fits a paste", () => {
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		const bundle = openBootstrapBundle(frame, sw, "n1", "sakura");
		expect(bundle.domain.admissions).toHaveLength(1);
		expect(bundle.domain.revocations).toHaveLength(0);
		expect(bundle.transport.routerCertFp).toHaveLength(64);
		const wire = JSON.stringify(frame).length;
		expect(wire, `sealed frame is ${wire} bytes`).toBeLessThan(2048);
	});
});
