import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerOpIntake } from "../federation-server/inbox/ownerOpIntake.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerLock, OwnerLockHeld } from "../federation-server/owner/ownerLock.js";
import { OwnerQuarantined, OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import { createConsolePushOps, ownerRowBody } from "../gateway/consolePushOps.js";
import { REGISTER_MAX_SKEW_MS, signAdmission } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import * as atomicWrite from "../shared/atomic-write.js";
import { fingerprint, generateIdentity } from "../shared/crypto.js";
import { ownerKeyId } from "../shared/owner-id.js";
import { OwnerOpSchema, signOwnerOp, signRowEnvelope } from "../shared/schemasInbox.js";
import { Address } from "../shared/session-id.js";

const roots: string[] = [];
const key = { domainId: "domain", ownerSignPub: Buffer.alloc(32, 7).toString("base64") };
const root = () => {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "owner-state-"));
	roots.push(value);
	return value;
};
const open = (
	dir: string,
	quota = new DomainQuota({ dir, limitBytes: 10_000_000, statfs: () => ({ available: 100_000_000 }) }),
) => OwnerStateStore.open({ dataDir: dir, key, quota, ambient: processAmbient(), heartbeatMs: 10, staleMs: 100 });
const ownerDir = (dir: string) => path.join(dir, "owner", key.domainId, fingerprint(key.ownerSignPub));
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OwnerStateStore", () => {
	it("puts and gets records with monotonic versions", () => {
		const store = open(root());
		expect(store.put("board.meta", "a", null, { clear: { x: 1 } })).toMatchObject({ kind: "ok", version: 1 });
		expect(store.put("board.meta", "a", 1, { clear: { x: 2 } })).toMatchObject({ kind: "ok", version: 2 });
		expect(store.get("board.meta", "a")).toMatchObject({ version: 2, clear: { x: 2 } });
		store.close();
	});

	it("returns the live record for conflicts, including stale deletes", () => {
		const store = open(root());
		store.put("share", "s", null, { clear: { live: true } });
		store.put("share", "s", 1, { clear: { newer: true } });
		const conflict = store.put("share", "s", 1, { clear: {} });
		expect(conflict).toMatchObject({ kind: "conflict", current: { version: 2 } });
		expect(store.del("share", "s", 1)).toMatchObject({ kind: "conflict", current: { version: 2 } });
		store.close();
	});

	it("keeps independent address sequences and filters rows", () => {
		const store = open(root());
		expect(store.append("a", { n: 1 })).toMatchObject({ seq: 1 });
		expect(store.append("a", { n: 2 })).toMatchObject({ seq: 2 });
		expect(store.append("b", { n: 1 })).toMatchObject({ seq: 1 });
		expect(store.rows("a", 2, 1)).toEqual([{ seq: 2, row: { n: 2 } }]);
		expect(store.retire("a", 1)).toMatchObject({ kind: "ok" });
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 2, row: { n: 2 } }]);
		store.close();
	});

	it("applies a batch atomically", () => {
		const store = open(root());
		store.put("share", "live", null, { clear: { x: 1 } });
		expect(
			store.batch((tx) => {
				tx.put("share", "new", null, { clear: { x: 2 } });
				tx.put("share", "live", 0, { clear: {} });
			}),
		).toMatchObject({ kind: "conflict" });
		expect(store.get("share", "new")).toBeNull();
		expect(store.get("share", "live")).toMatchObject({ clear: { x: 1 } });
		store.close();
	});

	it("replays writes and removes older segments after compaction", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "s", null, { clear: { ok: true } });
		store.append("a", { n: 1 });
		store.close();
		store = open(dir);
		expect(store.get("share", "s")).toMatchObject({ clear: { ok: true } });
		store.compact();
		store.close();
		expect(fs.readdirSync(ownerDir(dir)).filter((name) => name.startsWith("snapshot-")).length).toBe(1);
		store = open(dir);
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 1, row: { n: 1 } }]);
		store.close();
	});

	it("truncates a torn last line and continues sequences", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		fs.appendFileSync(journal, '{"seq":2');
		store = open(dir);
		expect(store.append("a", { n: 2 })).toMatchObject({ kind: "ok", seq: 2 });
		store.close();
	});

	it("treats one journal line as one batch", () => {
		const dir = root();
		const store = open(dir);
		store.batch((tx) => {
			tx.put("share", "a", null, { clear: { value: 1 } });
			tx.append("rows", { value: 2 });
		});
		const journal = fs.readFileSync(path.join(ownerDir(dir), "journal-0.log"), "utf8").trim();
		expect(JSON.parse(journal).ops).toHaveLength(2);
		store.close();
	});

	it("quarantines an earlier torn line and remains quarantined after reopen", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.append("a", { n: 2 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
		lines[0] = lines[0].slice(0, 8);
		fs.writeFileSync(journal, `${lines.join("\n")}\n`);
		store = open(dir);
		expect(() => store.rows("a", 1, 10)).toThrow(OwnerQuarantined);
		store.close();
		store = open(dir);
		expect(() => store.rows("a", 1, 10)).toThrow(OwnerQuarantined);
		expect(store.append("a", {})).toMatchObject({ kind: "quarantined" });
		store.close();
	});

	it("persists a manifest quarantine without renaming a corrupt manifest", () => {
		const dir = root();
		const store = open(dir);
		store.close();
		const manifest = path.join(ownerDir(dir), "MANIFEST.json");
		fs.writeFileSync(manifest, "{");
		const reopened = open(dir);
		expect(() => reopened.list("share")).toThrow(OwnerQuarantined);
		expect(fs.existsSync(manifest)).toBe(true);
		expect(fs.readdirSync(ownerDir(dir)).some((name) => name.includes("quarantine-"))).toBe(false);
		reopened.close();
	});

	it("reopens the pre-crash state after compact manifest failure", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "before", null, { clear: { value: 1 } });
		const original = atomicWrite.writeFileAtomic;
		vi.spyOn(atomicWrite, "writeFileAtomic").mockImplementation((file, ...args) => {
			if (path.basename(file) === "MANIFEST.json") throw new Error("manifest write");
			return original(file, ...args);
		});
		expect(() => store.compact()).toThrow("manifest write");
		store.close();
		vi.restoreAllMocks();
		store = open(dir);
		expect(store.get("share", "before")).toMatchObject({ clear: { value: 1 } });
		expect(fs.readdirSync(ownerDir(dir)).some((name) => name === "snapshot-1.json")).toBe(false);
		store.close();
	});

	it("replays a journal landed before the compact manifest rename", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "before", null, { clear: { value: 1 } });
		store.batch((tx) => {
			tx.put("share", "landed", null, { clear: { value: 2 } });
		});
		const original = atomicWrite.writeFileAtomic;
		vi.spyOn(atomicWrite, "writeFileAtomic").mockImplementation((file, source, options) => {
			if (path.basename(file) === "MANIFEST.json") {
				fs.writeFileSync([file, ".tmp.", String(process.pid)].join(""), source as string);
				throw new Error("crash before manifest rename");
			}
			original(file, source, options);
		});
		expect(() => store.compact()).toThrow("crash before manifest rename");
		store.close();
		vi.restoreAllMocks();
		store = open(dir);
		expect(store.get("share", "before")).toMatchObject({ clear: { value: 1 } });
		expect(store.get("share", "landed")).toMatchObject({ clear: { value: 2 } });
		store.close();
	});

	it("quarantines corrupt segments and refuses reads and writes", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		store.append("a", { n: 2 });
		store.close();
		const journal = path.join(ownerDir(dir), "journal-0.log");
		const lines = fs.readFileSync(journal, "utf8").split("\n");
		lines[0] = "{";
		fs.writeFileSync(journal, lines.join("\n"));
		const corrupted = fs.readFileSync(journal);
		store = open(dir);
		expect(() => store.get("presence.row", "x")).toThrow(OwnerQuarantined);
		expect(store.append("a", {})).toMatchObject({ kind: "quarantined", missing: { from: 1, to: 2 } });
		const quarantined = fs.readdirSync(ownerDir(dir)).find((name) => name.includes("journal-0.log.quarantine-"));
		expect(quarantined).toBeDefined();
		expect(fs.readFileSync(path.join(ownerDir(dir), quarantined as string))).toEqual(corrupted);
		store.close();
	});

	it("quarantines a corrupt snapshot and preserves its bytes", () => {
		const dir = root();
		let store = open(dir);
		store.put("share", "s", null, { clear: { x: 1 } });
		store.compact();
		store.close();
		const snapshot = path.join(ownerDir(dir), "snapshot-1.json");
		fs.writeFileSync(snapshot, "{");
		const corrupted = fs.readFileSync(snapshot);
		store = open(dir);
		expect(() => store.list("share")).toThrow(OwnerQuarantined);
		expect(store.put("share", "s", null, { clear: {} })).toMatchObject({ kind: "quarantined" });
		const quarantined = fs.readdirSync(ownerDir(dir)).find((name) => name.includes("snapshot-1.json.quarantine-"));
		expect(quarantined).toBeDefined();
		expect(fs.readFileSync(path.join(ownerDir(dir), quarantined as string))).toEqual(corrupted);
		store.close();
	});

	it("rejects a second live open and takes over stale ownership", () => {
		const dir = root();
		const first = open(dir);
		expect(() => open(dir)).toThrow(OwnerLockHeld);
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as {
			pid: number;
			generation: number;
			heartbeatAt: number;
		};
		fs.writeFileSync(lock, JSON.stringify({ ...value, heartbeatAt: Date.now() - 1000 }));
		const second = open(dir);
		expect(first.put("share", "old", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		second.close();
		first.close();
	});

	it("refuses quota writes without changing prior state", () => {
		const dir = root();
		const store = open(
			dir,
			new DomainQuota({ dir, limitBytes: 1, reserveBytes: 0, statfs: () => ({ available: 100 }) }),
		);
		expect(store.put("share", "s", null, { clear: { x: 1 } })).toMatchObject({ kind: "durability_failure" });
		expect(store.get("share", "s")).toBeNull();
		store.close();
	});

	it("reports uncertain fsync and remains usable", () => {
		const dir = root();
		const store = open(dir);
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("sync");
		});
		expect(store.put("share", "a", null, { clear: {} })).toMatchObject({ kind: "durability_uncertain" });
		expect(store.health().degraded).toBe(true);
		fsync.mockRestore();
		expect(store.put("share", "b", null, { clear: {} })).toMatchObject({ kind: "ok", seq: 2 });
		store.close();
	});

	it("truncates a short write and reopens clean", () => {
		const dir = root();
		let store = open(dir);
		store.append("a", { n: 1 });
		const original = fs.writeSync as unknown as (
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position?: number | null,
		) => number;
		let writes = 0;
		vi.spyOn(fs, "writeSync").mockImplementation((...args: unknown[]) => {
			const [fd, buffer, offset, length, position] = args as [
				number,
				NodeJS.ArrayBufferView,
				number,
				number,
				number | null | undefined,
			];
			if (writes++ === 0) return original(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
			throw new Error("write");
		});
		expect(store.put("share", "failed", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		store.close();
		vi.restoreAllMocks();
		store = open(dir);
		expect(store.get("share", "failed")).toBeNull();
		expect(store.rows("a", 1, 9)).toEqual([{ seq: 1, row: { n: 1 } }]);
		store.close();
	});

	it("settles quota on open and compact", () => {
		const dir = root();
		const seeded = open(dir);
		for (let n = 0; n < 50; n += 1) seeded.append("a", { n, pad: "x".repeat(1_000) });
		seeded.close();
		const quota = new DomainQuota({ dir, limitBytes: 100_000, statfs: () => ({ available: 100_000_000 }) });
		expect(quota.reserve(ownerDir(dir), 100_000)).toEqual({ ok: true });
		quota.release(ownerDir(dir), 100_000);
		const store = open(dir, quota);
		expect(quota.reserve(ownerDir(dir), 100_000)).toMatchObject({ ok: false, reason: "quota" });
		store.compact();
		expect(quota.reserve(ownerDir(dir), 100_000)).toMatchObject({ ok: false, reason: "quota" });
		store.close();
	});

	it("takes over a dead lock with a fresh heartbeat", () => {
		const dir = root();
		const first = open(dir);
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as Record<string, number>;
		fs.writeFileSync(lock, JSON.stringify({ ...value, pid: 999999, heartbeatAt: Date.now() }));
		const second = open(dir);
		expect(first.put("share", "old", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		second.close();
		first.close();
	});

	it("stops heartbeating after another holder rewrites the lock", async () => {
		const dir = root();
		const store = open(dir);
		const lock = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lock, "utf8")) as Record<string, number>;
		const before = new Map(
			fs
				.readdirSync(ownerDir(dir))
				.filter(
					(name) =>
						name === "MANIFEST.json" ||
						/^snapshot-\d+\.json$/.test(name) ||
						/^journal-\d+\.log$/.test(name),
				)
				.map((name) => [name, fs.readFileSync(path.join(ownerDir(dir), name))]),
		);
		fs.writeFileSync(lock, JSON.stringify({ ...value, generation: value.generation + 1 }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		store.compact();
		const after = new Map(
			fs
				.readdirSync(ownerDir(dir))
				.filter(
					(name) =>
						name === "MANIFEST.json" ||
						/^snapshot-\d+\.json$/.test(name) ||
						/^journal-\d+\.log$/.test(name),
				)
				.map((name) => [name, fs.readFileSync(path.join(ownerDir(dir), name))]),
		);
		expect([...after.entries()]).toEqual([...before.entries()]);
		expect(store.put("share", "lost", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		expect(JSON.parse(fs.readFileSync(lock, "utf8")).generation).toBe(value.generation + 1);
		store.close();
	});
});

describe("owner state boundaries", () => {
	it("rejects a live lock with OwnerLockHeld", () => {
		const dir = root();
		const lock = OwnerLock.open(dir, 60_000);
		try {
			expect(() => OwnerLock.open(dir, 60_000)).toThrow(OwnerLockHeld);
		} finally {
			lock.stop();
		}
	});

	it("matches the shared owner id vectors", () => {
		const vectors = JSON.parse(
			readFileSync(new URL("../../tests/fixtures/owner-id/vectors.json", import.meta.url), "utf8"),
		) as { cases: Array<{ signPub: string; ownerKeyId: string }> };
		expect(vectors.cases.map((vector) => ownerKeyId(vector.signPub))).toEqual(
			vectors.cases.map((vector) => vector.ownerKeyId),
		);
	});

	it("takes over a stale lock and fences the previous store", () => {
		const dir = root();
		const first = open(dir);
		const lockPath = path.join(ownerDir(dir), "owner.lock");
		const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { heartbeatAt: number };
		fs.writeFileSync(lockPath, JSON.stringify({ ...value, heartbeatAt: Date.now() - 1000 }));
		const second = open(dir);
		expect(first.put("share", "old", null, { clear: {} })).toMatchObject({ kind: "durability_failure" });
		second.close();
		first.close();
	});
});

function durableIntake() {
	const dir = root();
	const owner = generateIdentity();
	const consoleIdentity = generateIdentity();
	const router = generateIdentity();
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
		dataDir: dir,
		ownerOf: (domainId) => (domainId === "domain" ? owner.sign.pub : null),
		quotaFor: () => new DomainQuota({ dir, limitBytes: 10_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => 1_000_000 },
	});
	const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
	const intake = new OwnerOpIntake({
		inbox,
		getDomain: () => ({ ownerSignPub: owner.sign.pub, admissions: [admission], revocations: [] }),
		push: () => true,
		ambient: { now: () => 1_000_000 },
	});
	return { dir, owner, consoleIdentity, admission, registry, inbox, intake };
}

function signedOwnerOp(
	fixture: ReturnType<typeof durableIntake>,
	kind: string,
	nonce: string,
	value: Record<string, unknown> = {},
) {
	const fields = {
		v: 1 as const,
		domainId: "domain",
		signerSignPub: fixture.consoleIdentity.sign.pub,
		conversationId: "conversation",
		device: "phone",
		opId: `op-${nonce}`,
		at: 1_000_000,
		nonce: Buffer.from(nonce).toString("base64"),
		op: { kind, ...value },
	};
	return signOwnerOp(fields, fixture.consoleIdentity.sign.priv);
}

function consoleRow(fixture: ReturnType<typeof durableIntake>, opId: string) {
	const envelope = {
		origin: { kind: "console" as const, domainId: "domain", device: "phone" },
		opKey: { conversationId: "conversation", opId },
		epoch: "peer" as const,
		kind: "message" as const,
		contentRefs: [],
	};
	return {
		envelope,
		producerSig: signRowEnvelope(envelope, fixture.consoleIdentity.sign.priv),
		body: { ephemeralPub: "YQ==", nonce: "Yg==", ciphertext: "Yw==", signature: "ZA==" },
	};
}

describe("OwnerOpIntake", () => {
	it("persists registration, cursor state, and replay answers", async () => {
		const fixture = durableIntake();
		const registered = await fixture.intake.handle(signedOwnerOp(fixture, "consumer_register", "register"));
		const cursorEpoch = (registered as { cursorEpoch: number }).cursorEpoch;
		expect(registered).toMatchObject({ cursor: 0 });
		expect(await fixture.intake.handle(signedOwnerOp(fixture, "consumer_register", "register"))).toEqual(
			registered,
		);
		expect(await fixture.intake.handle(signedOwnerOp(fixture, "inbox_read", "read"))).toEqual([]);
		expect(
			await fixture.intake.handle(signedOwnerOp(fixture, "inbox_advance", "advance", { cursor: 1, cursorEpoch })),
		).toEqual({
			outcome: "ok",
		});
		expect(
			fixture.registry.for("domain").get("consumer", `consumer:${fixture.consoleIdentity.sign.pub}`),
		).toMatchObject({
			clear: { cursor: 1, cursorEpoch },
		});
		fixture.registry.close();
	});

	it("persists delivered rows and their result ledger", async () => {
		const fixture = durableIntake();
		const result = await fixture.intake.handle(
			signedOwnerOp(fixture, "deliver", "deliver", {
				address: `owner:domain/${fixture.owner.sign.pub}`,
				row: consoleRow(fixture, "op-deliver"),
			}),
		);
		expect(result).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(
			fixture.inbox.rows({ kind: "owner", domainId: "domain", ownerSignPub: fixture.owner.sign.pub }, 1, 10),
		).toHaveLength(1);
		expect(fixture.inbox.opResult("domain", { conversationId: "conversation", opId: "op-deliver" })).toEqual({
			opKey: { conversationId: "conversation", opId: "op-deliver" },
			outcome: "accepted",
			seq: 1,
		});
		fixture.registry.close();
	});

	it("stores accepted nonces and rejects them after intake recreation", async () => {
		const fixture = durableIntake();
		const op = signedOwnerOp(fixture, "consumer_register", "durable");
		expect(await fixture.intake.handle(op)).toMatchObject({ cursor: 0 });
		const second = new OwnerOpIntake({
			inbox: fixture.inbox,
			getDomain: () => ({
				ownerSignPub: fixture.owner.sign.pub,
				admissions: [fixture.admission],
				revocations: [],
			}),
			push: () => true,
			ambient: { now: () => 1_000_000 },
		});
		const replay = await second.handle(op);
		expect(replay).toMatchObject({ outcome: "refused", reason: "replay" });
		expect(
			fixture.inbox.ownerOpNonce(
				"domain",
				fixture.consoleIdentity.sign.pub,
				Buffer.from("durable").toString("base64"),
			),
		).toEqual({ at: 1_000_000 });
		fixture.registry.close();
	});

	it("sweeps only expired durable nonces", () => {
		const fixture = durableIntake();
		const nonce = Buffer.from("n").toString("base64");
		fixture.inbox.acceptOwnerOpNonce("domain", "exact", nonce, 1_000_000 - REGISTER_MAX_SKEW_MS);
		fixture.inbox.acceptOwnerOpNonce("domain", "past", nonce, 1_000_000 - REGISTER_MAX_SKEW_MS - 1);
		fixture.inbox.acceptOwnerOpNonce("domain", "inside", nonce, 1_000_000 - REGISTER_MAX_SKEW_MS + 1);
		fixture.inbox.sweep(1_000_000);
		expect(fixture.inbox.ownerOpNonce("domain", "exact", nonce)).not.toBeNull();
		expect(fixture.inbox.ownerOpNonce("domain", "past", nonce)).toBeNull();
		expect(fixture.inbox.ownerOpNonce("domain", "inside", nonce)).not.toBeNull();
		fixture.registry.close();
	});
});

describe("OwnerOpSchema", () => {
	it("accepts fixture values and rejects each field rule violation", () => {
		const rules = JSON.parse(
			readFileSync(new URL("../../tests/fixtures/owner-op/field-rules.json", import.meta.url), "utf8"),
		) as {
			fields: Record<string, { pattern: string; maxLength?: number; violation: string }>;
		};
		const vector = JSON.parse(
			readFileSync(new URL("../../tests/fixtures/owner-op/vectors.json", import.meta.url), "utf8"),
		) as {
			ownerOp: { value: Record<string, unknown>; signature: string };
		};
		const value = { ...vector.ownerOp.value, signature: vector.ownerOp.signature };
		expect(OwnerOpSchema.safeParse(value).success).toBe(true);
		const rejected = Object.entries(rules.fields).map(([field, rule]) => [field, rule.violation]);
		expect(
			rejected.every(([field, candidate]) => !OwnerOpSchema.safeParse({ ...value, [field]: candidate }).success),
		).toBe(true);
	});
});

describe("OwnerRowOutbox", () => {
	it("persists queued rows across recreation and deduplicates replacement keys", async () => {
		const dir = root();
		const producer = generateIdentity();
		const push = createConsolePushOps({
			dataDir: dir,
			ambient: processAmbient(),
			ownerId: () => "owner",
			routerClient: {
				isConnected: () => false,
				isRegistered: () => false,
				callInboxTool: async () => ({}) as never,
			},
			localGatewayId: "gateway",
			localDomainId: "domain",
			producerSignPriv: producer.sign.priv,
			ownerSignPub: () => key.ownerSignPub,
			contentKeyStore: { seal: () => ({ kind: "no_key" as const }) },
			localAddress: () => Address.local("domain", "gateway", "spawn", "session"),
			refuseImpersonation: () => null,
		});
		push.deliverToOwner({ entry: { kind: "notice", session_id: "notice.one", body: "one" }, dedupeKey: "same" });
		push.deliverToOwner({ entry: { kind: "notice", session_id: "notice.one", body: "two" }, dedupeKey: "same" });
		const stored = JSON.parse(fs.readFileSync(path.join(dir, "owner-row-outbox.json"), "utf8")) as Array<{
			entry: { body: string };
		}>;
		expect(stored.map((row) => row.entry.body)).toEqual(["two"]);
	});

	it("persists mirrored peer entries", () => {
		const dir = root();
		const producer = generateIdentity();
		const push = createConsolePushOps({
			dataDir: dir,
			ambient: processAmbient(),
			ownerId: () => "owner",
			routerClient: {
				isConnected: () => false,
				isRegistered: () => false,
				callInboxTool: async () => ({}) as never,
			},
			localGatewayId: "gateway",
			localDomainId: "domain",
			producerSignPriv: producer.sign.priv,
			ownerSignPub: () => key.ownerSignPub,
			contentKeyStore: { seal: () => ({ kind: "no_key" as const }) },
			localAddress: () => Address.local("domain", "gateway", "spawn", "session"),
			refuseImpersonation: () => null,
		});
		push.mirrorPeer(
			Address.local("domain", "gateway", "spawn", "session"),
			"from",
			"to",
			{ body: "peer" },
			"peer-row",
		);
		const stored = JSON.parse(fs.readFileSync(path.join(dir, "owner-row-outbox.json"), "utf8")) as Array<{
			entry: { kind: string };
		}>;
		expect(stored[0]?.entry.kind).toBe("peer");
	});

	it("produces the pinned mailbox value", () => {
		const pinned = JSON.parse(
			readFileSync(new URL("../../tests/fixtures/protocol/owner-row-reply.json", import.meta.url), "utf8"),
		);
		expect(
			ownerRowBody({ kind: "reply", session_id: "host.82d560", body: "done", status: "ok" }, 1757000000000),
		).toEqual(pinned);
	});
});
