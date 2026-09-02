import { describe, expect, it } from "vitest";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { signAdmission } from "../shared/admission.js";
import { generateIdentity } from "../shared/crypto.js";
import { signOwnerOp, signRowEnvelope } from "../shared/schemasInbox.js";

function setup(options: { pushResult?: boolean; quarantined?: boolean } = {}) {
	const owner = generateIdentity();
	const consoleIdentity = generateIdentity();
	const gateway = generateIdentity();
	const admission = signAdmission(
		{
			kind: "console",
			signPub: consoleIdentity.sign.pub,
			boxPub: consoleIdentity.box.pub,
			issuedAt: 1,
			nonce: "admit",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	const calls: unknown[][] = [];
	const waking: unknown[][] = [];
	const inbox = {
		appendRow: () => {
			if (options.quarantined) throw new OwnerQuarantined({ from: 1, to: 1 });
			return { outcome: "accepted", opKey: { conversationId: "c", opId: "o" }, seq: 1, row: { seq: 1 } };
		},
		registerConsumer: () => ({ cursor: 0, cursorEpoch: 1 }),
		rows: () => [],
		readOwner: () => [],
		advanceCursor: () => ({ outcome: "ok" }),
		opResult: () => null,
	} as never;
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] }),
		push: (...args) => {
			calls.push(args);
			return options.pushResult ?? true;
		},
		now: () => 1_000_000,
	});
	(inbox as { markWaking?: (...args: unknown[]) => void }).markWaking = (...args) => waking.push(args);
	return { owner, consoleIdentity, gateway, intake, calls, waking };
}

function op(
	fixture: ReturnType<typeof setup>,
	kind: string,
	nonce: string,
	options: { signer?: string; at?: number; value?: Record<string, unknown> } = {},
) {
	const fields = {
		v: 1 as const,
		domainId: "domain",
		signerSignPub: options.signer ?? fixture.consoleIdentity.sign.pub,
		conversationId: "c",
		device: "phone",
		opId: `o-${nonce}`,
		at: options.at ?? 1_000_000,
		nonce: Buffer.from(nonce).toString("base64"),
		op: { kind, ...(options.value ?? {}) },
	};
	return signOwnerOp(
		fields,
		options.signer === fixture.gateway.sign.pub ? fixture.gateway.sign.priv : fixture.consoleIdentity.sign.priv,
	);
}

describe("OwnerOpIntake", () => {
	it("accepts admitted console operations and serves registry reads", async () => {
		const fixture = setup();
		expect(await fixture.intake.handle(op(fixture, "consumer_register", "register"))).toMatchObject({
			cursorEpoch: 1,
		});
		expect(await fixture.intake.handle(op(fixture, "inbox_read", "read"))).toEqual([]);
		expect(
			await fixture.intake.handle(
				op(fixture, "inbox_advance", "advance", { value: { cursor: 0, cursorEpoch: 1 } }),
			),
		).toEqual({ outcome: "ok" });
	});

	it("refuses unauthorized, replayed, stale, mismatched, and unsupported operations", async () => {
		const fixture = setup();
		expect(
			await fixture.intake.handle(
				op(fixture, "consumer_register", "gateway", { signer: fixture.gateway.sign.pub }),
			),
		).toMatchObject({ outcome: "refused" });
		expect(await fixture.intake.handle(op(fixture, "consumer_register", "replay"))).toMatchObject({
			cursorEpoch: 1,
		});
		expect(await fixture.intake.handle(op(fixture, "consumer_register", "replay"))).toMatchObject({
			outcome: "refused",
		});
		expect(await fixture.intake.handle(op(fixture, "consumer_register", "stale", { at: 1 }))).toMatchObject({
			outcome: "refused",
		});
		expect(await fixture.intake.handle(op(fixture, "unsupported", "unsupported"))).toMatchObject({
			outcome: "refused",
		});
	});

	it("refuses a foreign Domain, a foreign device, and clear rows", async () => {
		const fixture = setup();
		const validRow = {
			envelope: {
				origin: { kind: "console" as const, domainId: "domain", device: "phone" },
				opKey: { conversationId: "c", opId: "o-foreign" },
				epoch: "peer" as const,
				kind: "message" as const,
				contentRefs: [],
			},
			producerSig: "",
			body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
		};
		validRow.producerSig = signRowEnvelope(validRow.envelope, fixture.consoleIdentity.sign.priv);
		expect(
			await fixture.intake.handle(
				op(fixture, "deliver", "foreign-domain", {
					value: { address: "owner:other/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", row: validRow },
				}),
			),
		).toMatchObject({ outcome: "refused" });
		const foreignDevice = {
			...validRow,
			envelope: {
				...validRow.envelope,
				opKey: { conversationId: "c", opId: "o-device" },
				origin: { ...validRow.envelope.origin, device: "tablet" },
			},
		};
		foreignDevice.producerSig = signRowEnvelope(foreignDevice.envelope, fixture.consoleIdentity.sign.priv);
		expect(
			await fixture.intake.handle(
				op(fixture, "deliver", "foreign-device", {
					value: { address: "owner:domain/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", row: foreignDevice },
				}),
			),
		).toMatchObject({ outcome: "refused" });
	});

	it("marks an accepted row waking when push does not take it", async () => {
		const fixture = setup({ pushResult: false });
		const row = {
			envelope: {
				origin: { kind: "console" as const, domainId: "domain", device: "phone" },
				opKey: { conversationId: "c", opId: "o-wake" },
				epoch: "peer" as const,
				kind: "message" as const,
				contentRefs: [],
			},
			producerSig: "",
			body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
		};
		row.producerSig = signRowEnvelope(row.envelope, fixture.consoleIdentity.sign.priv);
		const result = await fixture.intake.handle(
			op(fixture, "deliver", "wake", {
				value: { address: "owner:domain/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", row },
			}),
		);
		expect(result).toMatchObject({ outcome: "accepted" });
		expect(fixture.waking).toHaveLength(1);
	});

	it("answers durability uncertainty for a quarantined inbox", async () => {
		const fixture = setup({ quarantined: true });
		const row = {
			envelope: {
				origin: { kind: "console" as const, domainId: "domain", device: "phone" },
				opKey: { conversationId: "c", opId: "o-quarantine" },
				epoch: "peer" as const,
				kind: "message" as const,
				contentRefs: [],
			},
			producerSig: "",
			body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
		};
		row.producerSig = signRowEnvelope(row.envelope, fixture.consoleIdentity.sign.priv);
		expect(
			await fixture.intake.handle(
				op(fixture, "deliver", "quarantine", {
					value: { address: "owner:domain/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", row },
				}),
			),
		).toMatchObject({ outcome: "durability_uncertain" });
	});
});
