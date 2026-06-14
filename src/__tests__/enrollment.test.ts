import { describe, expect, it } from "vitest";
import { resolveAdmitted, verifyAdmission } from "../shared/admission.js";
import { fingerprint, generateIdentity } from "../shared/crypto.js";
import { admissionFromScan, EnrollmentPayloadSchema, payloadSas } from "../shared/enrollment.js";

const owner = generateIdentity();
const host = generateIdentity();

describe("enrollment", () => {
	it("parses each enrollment payload type and rejects an unknown one", () => {
		expect(
			EnrollmentPayloadSchema.safeParse({ type: "admit-host", hostId: "laptop", signPub: "a", boxPub: "b" })
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
		const payload = { type: "admit-host" as const, hostId: "laptop", signPub: host.sign.pub, boxPub: host.box.pub };
		expect(payloadSas(payload)).toBe(fingerprint(host.sign.pub));
	});

	it("admits a scanned Host into the allowlist", () => {
		const payload = { type: "admit-host" as const, hostId: "laptop", signPub: host.sign.pub, boxPub: host.box.pub };
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 1000, "bg==");
		expect(verifyAdmission(signed, owner.sign.pub)).toBe(true);
		const got = resolveAdmitted([signed], [], owner.sign.pub, host.sign.pub);
		expect(got).toMatchObject({ kind: "host", hostId: "laptop", boxPub: host.box.pub });
	});

	it("admits a scanned phone with kind phone (no hostId)", () => {
		const phone = generateIdentity();
		const payload = {
			type: "authorize-phone" as const,
			domainId: "d",
			signPub: phone.sign.pub,
			boxPub: phone.box.pub,
		};
		const signed = admissionFromScan(payload, owner.sign.priv, owner.sign.pub, 2000, "cg==");
		expect(signed.admission.kind).toBe("phone");
		expect(signed.admission.hostId).toBeUndefined();
		expect(resolveAdmitted([signed], [], owner.sign.pub, phone.sign.pub)?.kind).toBe("phone");
	});
});
