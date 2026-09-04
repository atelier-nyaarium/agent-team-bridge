import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { REGISTER_MAX_SKEW_MS, signAdmission } from "../shared/admission.js";
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

	it("answers a re-posted in-flight op with that op's one answer, running it once", async () => {
		const fixture = setup();
		let runs = 0;
		let release: ((value: unknown) => void) | undefined;
		fixture.intake.register("slow", () => {
			runs++;
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		const first = fixture.intake.handle(op(fixture, "slow", "same"));
		const second = fixture.intake.handle(op(fixture, "slow", "same"));
		release?.({ answered: true });

		expect(await first).toEqual({ answered: true });
		expect(await second).toEqual({ answered: true });
		expect(runs).toBe(1);
	});

	it("refuses unauthorized, stale, mismatched, and unsupported operations, and answers a replay with its first result", async () => {
		const fixture = setup();
		expect(
			await fixture.intake.handle(
				op(fixture, "consumer_register", "gateway", { signer: fixture.gateway.sign.pub }),
			),
		).toMatchObject({ outcome: "refused" });
		const registered = await fixture.intake.handle(op(fixture, "consumer_register", "replay"));
		expect(registered).toMatchObject({ cursorEpoch: 1 });
		expect(await fixture.intake.handle(op(fixture, "consumer_register", "replay"))).toEqual(registered);
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

	it("refuses console delivery to an old gateway protocol", async () => {
		const fixture = setup();
		const row = {
			envelope: {
				origin: { kind: "console" as const, domainId: "domain", device: "phone" },
				opKey: { conversationId: "c", opId: "o-old-console" },
				epoch: "peer" as const,
				kind: "console_op" as const,
				contentRefs: [],
			},
			producerSig: "",
			body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
		};
		row.producerSig = signRowEnvelope(row.envelope, fixture.consoleIdentity.sign.priv);
		fixture.intake.setGatewayProtocol(() => 1);
		expect(
			await fixture.intake.handle(
				op(fixture, "deliver", "old-console", {
					value: { address: "session:domain/gateway/session", row },
				}),
			),
		).toEqual({
			opKey: { conversationId: "c", opId: "o-old-console" },
			outcome: "refused",
			reason: "unsupported",
		});
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

	it("refuses a nonce accepted by a previous intake over the same store", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-op-nonce-"));
		const owner = generateIdentity();
		const consoleIdentity = generateIdentity();
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
		const registry = new OwnerStoreRegistry({
			dataDir: root,
			ownerOf: () => owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({ dir: root, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			now: () => 1_000_000,
		});
		const router = generateIdentity();
		const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const params = {
			inbox,
			getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] }),
			push: () => true,
			now: () => 1_000_000,
		};
		const first = new OwnerOpIntake(params);
		const second = new OwnerOpIntake(params);
		const fixture = { owner, consoleIdentity, gateway: generateIdentity() } as ReturnType<typeof setup>;
		expect(
			await first.handle(op(fixture, "consumer_register", "durable", { signer: consoleIdentity.sign.pub })),
		).toMatchObject({
			cursor: 0,
		});
		expect(
			await second.handle(op(fixture, "consumer_register", "durable", { signer: consoleIdentity.sign.pub })),
		).toMatchObject({
			outcome: "refused",
			reason: "replay",
		});
		registry.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("sweeps only nonces older than the skew window", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-op-sweep-"));
		const now = 1_000_000;
		const owner = generateIdentity();
		const registry = new OwnerStoreRegistry({
			dataDir: root,
			ownerOf: () => owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({ dir: root, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			now: () => now,
		});
		const router = generateIdentity();
		const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		inbox.acceptOwnerOpNonce("domain", "exact", "n", now - REGISTER_MAX_SKEW_MS);
		inbox.acceptOwnerOpNonce("domain", "past", "n", now - REGISTER_MAX_SKEW_MS - 1);
		inbox.acceptOwnerOpNonce("domain", "inside", "n", now - REGISTER_MAX_SKEW_MS + 1);
		inbox.sweep(now);
		expect(inbox.ownerOpNonce("domain", "exact", "n")).not.toBeNull();
		expect(inbox.ownerOpNonce("domain", "past", "n")).toBeNull();
		expect(inbox.ownerOpNonce("domain", "inside", "n")).not.toBeNull();
		inbox.sweep(now);
		expect(inbox.ownerOpNonce("domain", "inside", "n")).not.toBeNull();
		registry.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
});
