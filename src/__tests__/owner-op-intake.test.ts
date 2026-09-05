import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OWNER_OP_KIND_LIST, OwnerOpValueUnion } from "../federation-server/ownerOpRegistry.js";
import { signAdmission } from "../shared/admission.js";
import { fingerprint, generateIdentity } from "../shared/crypto.js";
import { FEDERATION_VALUE_PROTOCOL_VERSION } from "../shared/router-protocol.js";
import { ConsoleOpSchema } from "../shared/schemas.js";
import { signOwnerOp, signRowEnvelope } from "../shared/schemasInbox.js";
import { mintIdentitySet } from "../testing/identitySet.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function localIntake(options: { maxCachedAnswers?: number } = {}) {
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
	const inbox = {
		registerConsumer: () => ({ cursor: 0, cursorEpoch: 1 }),
		ownerOpNonce: () => null,
		acceptOwnerOpNonce: () => true,
	} as never;
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: (domainId) =>
			domainId === "domain" ? { ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] } : null,
		push: () => true,
		now: () => 1_000_000,
		...options,
	});
	return { owner, consoleIdentity, intake };
}

function signedOp(
	fixture: ReturnType<typeof localIntake>,
	value: Record<string, unknown>,
	options: {
		domainId?: string;
		device?: string;
		opId?: string;
		nonce?: string;
		signer?: ReturnType<typeof generateIdentity>;
	} = {},
) {
	const signer = options.signer ?? fixture.consoleIdentity;
	return signOwnerOp(
		{
			v: 1,
			domainId: options.domainId ?? "domain",
			signerSignPub: signer.sign.pub,
			conversationId: "conversation",
			device: options.device ?? "phone",
			opId: options.opId ?? "op-1",
			at: 1_000_000,
			nonce: Buffer.from(options.nonce ?? options.opId ?? "nonce").toString("base64"),
			op: value,
		},
		signer.sign.priv,
	);
}

function rowFor(op: ReturnType<typeof signedOp>, epoch: number | "clear" = 1) {
	const envelope = {
		origin: {
			kind: epoch === "clear" ? ("router" as const) : ("console" as const),
			domainId: op.domainId,
			device: op.device,
		},
		opKey: { conversationId: op.conversationId, opId: op.opId },
		epoch,
		kind: epoch === "clear" ? ("op_result" as const) : ("console_op" as const),
		contentRefs: [],
	};
	const body =
		epoch === "clear"
			? {}
			: {
					v: 1 as const,
					epoch,
					nonce: Buffer.alloc(12).toString("base64"),
					ciphertext: Buffer.alloc(16).toString("base64"),
				};
	return { envelope, producerSig: signRowEnvelope(envelope, op.signerSignPub), body };
}

describe("OwnerOp intake", () => {
	it("shares one in-flight answer, retries an unsettled failure, and evicts answers oldest-first", async () => {
		const fixture = localIntake({ maxCachedAnswers: 2 });
		let runs = 0;
		let release: ((value: unknown) => void) | undefined;
		fixture.intake.register("hello", () => {
			runs++;
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		const first = fixture.intake.handle(signedOp(fixture, { kind: "hello" }, { opId: "same" }));
		const second = fixture.intake.handle(signedOp(fixture, { kind: "hello" }, { opId: "same" }));
		release?.({ run: 1 });
		expect(await Promise.all([first, second])).toEqual([{ run: 1 }, { run: 1 }]);
		expect(runs).toBe(1);

		let attempts = 0;
		fixture.intake.register("board_read", () => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			return { run: attempts };
		});
		await expect(
			fixture.intake.handle(signedOp(fixture, { kind: "board_read" }, { opId: "flaky" })),
		).rejects.toThrow();
		expect(await fixture.intake.handle(signedOp(fixture, { kind: "board_read" }, { opId: "flaky" }))).toEqual({
			run: 2,
		});

		fixture.intake.register("presence_read", () => ({ run: ++runs }));
		const counted = { kind: "presence_read" };
		expect(await fixture.intake.handle(signedOp(fixture, counted, { opId: "a" }))).toEqual({ run: 2 });
		expect(await fixture.intake.handle(signedOp(fixture, counted, { opId: "b" }))).toEqual({ run: 3 });
		expect(await fixture.intake.handle(signedOp(fixture, counted, { opId: "c" }))).toEqual({ run: 4 });
		expect(await fixture.intake.handle(signedOp(fixture, counted, { opId: "a" }))).toEqual({ run: 5 });
	});

	it("refuses a foreign Domain, foreign device, clear row, and an old gateway protocol", async () => {
		const fixture = localIntake();
		const foreignDomain = await fixture.intake.handle(
			signedOp(fixture, { kind: "consumer_register" }, { domainId: "other" }),
		);
		expect(foreignDomain).toMatchObject({ outcome: "refused" });
		const foreignDevice = await fixture.intake.handle(
			signedOp(
				fixture,
				{
					kind: "deliver",
					address: "owner:domain/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					row: rowFor(signedOp(fixture, { kind: "x" }, { device: "tablet", opId: "device" }), 1),
				},
				{ opId: "device" },
			),
		);
		expect(foreignDevice).toMatchObject({ outcome: "refused" });
		const clearOp = signedOp(
			fixture,
			{
				kind: "deliver",
				address: "owner:domain/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
				row: rowFor(signedOp(fixture, { kind: "x" }), "clear"),
			},
			{ opId: "clear" },
		);
		expect(await fixture.intake.handle(clearOp)).toMatchObject({ outcome: "refused" });
		fixture.intake.setGatewayProtocol(() => FEDERATION_VALUE_PROTOCOL_VERSION - 1);
		const old = signedOp(
			fixture,
			{
				kind: "deliver",
				address: "session:domain/gateway/session",
				row: rowFor(signedOp(fixture, { kind: "x" }, { opId: "old" }), 1),
			},
			{ opId: "old" },
		);
		expect(await fixture.intake.handle(old)).toMatchObject({ outcome: "refused", reason: "unsupported" });
	});

	it("returns durability uncertainty while the owner store is quarantined", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-op-quarantine-"));
		roots.push(root);
		const set = mintIdentitySet({ domainId: "domain", gatewayId: "gateway" });
		const registry = new OwnerStoreRegistry({
			dataDir: root,
			ownerOf: () => set.domain.owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({ dir: root, limitBytes: 10_000_000, statfs: () => ({ available: 10_000_000 }) }),
			now: () => 1_000_000,
		});
		const store = registry.for(set.domain.id);
		store.append("rows", { value: 1 });
		store.append("rows", { value: 2 });
		store.close();
		const ownerDir = path.join(root, "owner", set.domain.id, fingerprint(set.domain.owner.sign.pub));
		const journal = path.join(ownerDir, "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
		lines[0] = "{";
		fs.writeFileSync(journal, `${lines.join("\n")}\n`);
		const reopened = new OwnerStoreRegistry({
			dataDir: root,
			ownerOf: () => set.domain.owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({ dir: root, limitBytes: 10_000_000, statfs: () => ({ available: 10_000_000 }) }),
			now: () => 1_000_000,
		});
		const inbox = new InboxService(reopened, {
			signPub: set.router.identity.sign.pub,
			signPriv: set.router.identity.sign.priv,
		});
		const intake = new OwnerOpIntake({
			inbox,
			getDomain: () => ({
				ownerSignPub: set.domain.owner.sign.pub,
				admissions: [set.console.admission],
				revocations: [],
			}),
			push: () => true,
			now: () => 1_000_000,
		});
		expect(
			await intake.handle(
				signOwnerOp(
					{ ...setToFields(set), op: { kind: "consumer_register", incarnation: 0 } },
					set.console.identity.sign.priv,
				),
			),
		).toMatchObject({
			outcome: "durability_uncertain",
		});
		reopened.close();
	});

	it("catalogues every served kind and refuses one it does not", () => {
		const fixture = localIntake();
		const register = (kind: string, handler: () => null) =>
			(fixture.intake.register as (k: string, h: () => null) => void).call(fixture.intake, kind, handler);
		register("board_read", () => null);
		expect(() => register("board_read", () => null)).toThrow(/already registered/);
		expect(() => register("nope", () => null)).toThrow(/not in the catalog/);
		// Each schema names its own kind, or the union would not build.
		expect(OwnerOpValueUnion.options).toHaveLength(OWNER_OP_KIND_LIST.length);
		expect(new Set(OWNER_OP_KIND_LIST).size).toBe(OWNER_OP_KIND_LIST.length);
	});

	it("requires each ConsoleOp kind's fields", () => {
		const cases = [
			[{ kind: "send", to: "x", body: "y" }, ["to", "body"]],
			[{ kind: "respond", session_id: "s" }, ["session_id"]],
			[{ kind: "report_read", team: "t", epoch: 0, seq: 0 }, ["team", "epoch", "seq"]],
			[{ kind: "tmux_send", target: "t" }, ["target"]],
			[{ kind: "create_session", target: "t" }, ["target"]],
			[{ kind: "list_dirs", path: "" }, ["path"]],
			[
				{
					kind: "cross_domain_request",
					listeningToken: "t",
					pin: "p",
					requesterOwnerSignPub: "o",
					requesterDomainId: "d",
					requesterGatewayId: "g",
				},
				["listeningToken", "pin", "requesterOwnerSignPub", "requesterDomainId", "requesterGatewayId"],
			],
			[{ kind: "cross_domain_unlink", domainId: "d" }, ["domainId"]],
		] as const;
		for (const [value, required] of cases) {
			expect(ConsoleOpSchema.safeParse(value).success).toBe(true);
			for (const field of required) {
				const rejected = { ...value } as Record<string, unknown>;
				delete rejected[field];
				expect(ConsoleOpSchema.safeParse(rejected).success).toBe(false);
			}
		}
	});
});

function setToFields(set: ReturnType<typeof mintIdentitySet>) {
	return {
		v: 1 as const,
		domainId: set.domain.id,
		signerSignPub: set.console.identity.sign.pub,
		conversationId: set.console.conversationId,
		device: set.console.device,
		opId: "quarantine",
		at: 1_000_000,
		nonce: Buffer.from("quarantine").toString("base64"),
	};
}
