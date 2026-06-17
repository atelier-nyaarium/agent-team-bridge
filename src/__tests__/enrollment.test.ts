import { describe, expect, it } from "vitest";
import { resolveAdmitted, signAdmission, verifyAdmission } from "../shared/admission.js";
import { fingerprint, generateIdentity } from "../shared/crypto.js";
import { admissionFromScan, EnrollmentPayloadSchema, EnrollOpSchema, payloadSas } from "../shared/enrollment.js";

const owner = generateIdentity();
const host = generateIdentity();

describe("enrollment", () => {
	it("parses each enrollment payload type and rejects an unknown one", () => {
		expect(
			EnrollmentPayloadSchema.safeParse({ type: "admit-switch", switchId: "laptop", signPub: "a", boxPub: "b" })
				.success,
		).toBe(true);
		expect(
			EnrollmentPayloadSchema.safeParse({
				type: "enroll-owner",
				domainId: "d",
				evieAddr: "https://evie",
				evieSignPub: "s",
				evieBoxPub: "b",
				nonce: "n",
			}).success,
		).toBe(true);
		expect(EnrollmentPayloadSchema.safeParse({ type: "nope" }).success).toBe(false);
	});

	it("derives the SAS from the confirmed signing key", () => {
		const payload = {
			type: "admit-switch" as const,
			switchId: "laptop",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
		};
		expect(payloadSas(payload)).toBe(fingerprint(host.sign.pub));
	});

	it("admits a scanned Switch into the allowlist", () => {
		const payload = {
			type: "admit-switch" as const,
			switchId: "laptop",
			signPub: host.sign.pub,
			boxPub: host.box.pub,
		};
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 1000, "bg==");
		expect(verifyAdmission(signed, owner.sign.pub)).toBe(true);
		const got = resolveAdmitted([signed], [], owner.sign.pub, host.sign.pub);
		expect(got).toMatchObject({ kind: "switch", switchId: "laptop", boxPub: host.box.pub });
	});

	it("parses each enroll op and rejects an unfilled redeem", () => {
		expect(
			EnrollOpSchema.safeParse({ kind: "enroll_redeem", nonce: "n", ownerSignPub: "s", ownerBoxPub: "b" })
				.success,
		).toBe(true);
		const signed = signAdmission(
			{
				kind: "switch",
				signPub: host.sign.pub,
				boxPub: host.box.pub,
				switchId: "laptop",
				issuedAt: 1,
				nonce: "bg==",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(EnrollOpSchema.safeParse({ kind: "submit_admission", admission: signed }).success).toBe(true);
		// Missing the owner keys: a redeem without them cannot root the Domain.
		expect(EnrollOpSchema.safeParse({ kind: "enroll_redeem", nonce: "n" }).success).toBe(false);
	});

	it("admits a scanned console with kind console (no switchId)", () => {
		const device = generateIdentity();
		const payload = {
			type: "authorize-console" as const,
			domainId: "d",
			signPub: device.sign.pub,
			boxPub: device.box.pub,
		};
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 2000, "cg==");
		expect(signed.admission.kind).toBe("console");
		expect(signed.admission.switchId).toBeUndefined();
		expect(resolveAdmitted([signed], [], owner.sign.pub, device.sign.pub)?.kind).toBe("console");
	});
});
