import { describe, expect, it } from "vitest";
import { openBootstrapBundle } from "../gateway/federation/bootstrapInstall.js";
import { type Admission, signAdmission } from "../shared/admission.js";
import { deriveContentKey, wrapContentKey } from "../shared/content-envelope.js";
import { generateIdentity, type Identity, seal } from "../shared/crypto.js";

function buildFrame(
	owner: Identity,
	sw: Identity,
	console_: Identity,
	nonce: string,
	gatewayId: string,
	admissionSigner: Identity = owner,
	epochs = 1,
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
	const consoleAdmission = signAdmission(
		{
			kind: "console",
			signPub: console_.sign.pub,
			boxPub: console_.box.pub,
			issuedAt: 1000,
			nonce: "Y29uc29sZQ==",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
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
		domain: { ownerSignPub: owner.sign.pub, admissions: [signed, consoleAdmission], revocations: [] },
		domainId: "a95dd4e979aa3be5",
		contentKeys: Array.from({ length: epochs }, (_, index) =>
			wrapContentKey(
				deriveContentKey(owner.sign.priv, "a95dd4e979aa3be5", index + 1),
				index + 1,
				sw.box.pub,
				owner.sign.pub,
				owner.sign.priv,
			),
		),
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

	it("installs the admissions and content keys within paste limits", () => {
		for (const [epochs, limit] of [
			[1, 3072],
			[3, 4096],
		] as const) {
			const frame = buildFrame(owner, sw, console_, "n1", "sakura", owner, epochs);
			const bundle = openBootstrapBundle(frame, sw, "n1", "sakura");
			expect(bundle.domain.admissions).toHaveLength(2);
			expect(bundle.contentKeys).toHaveLength(epochs);
			expect(JSON.stringify(frame).length).toBeLessThan(limit);
		}
		const frame = buildFrame(owner, sw, console_, "n1", "sakura");
		expect(openBootstrapBundle(frame, sw, "n1", "sakura").domain.revocations).toHaveLength(0);
		expect(openBootstrapBundle(frame, sw, "n1", "sakura").transport.routerCertFp).toHaveLength(64);
	});
});
