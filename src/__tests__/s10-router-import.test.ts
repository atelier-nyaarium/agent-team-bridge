import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { applyImport } from "../federation-server/migration/applyImport.js";
import { importBlobArtifacts } from "../federation-server/migration/blobTransfer.js";
import { createCursorService } from "../federation-server/migration/cursorService.js";
import { decideImport, type ImportMarker, markerKey } from "../federation-server/migration/importDecision.js";
import { dedupeRows } from "../federation-server/migration/importVerify.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerStateStore } from "../federation-server/owner/ownerStateStore.js";
import type { OwnerOpHandler } from "../federation-server/ownerServiceHooks.js";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { writeBlobArtifacts } from "../gateway/migration/blobArtifacts.js";
import { buildExport } from "../gateway/migration/exportSnapshot.js";
import { writeFileAtomic } from "../shared/atomic-write.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BoardAttachmentStore } from "../shared/board-attachment-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { DeviceMailboxStore } from "../shared/device-mailbox.js";
import { DurableStore } from "../shared/durable-store.js";
import { ownerKeyId } from "../shared/owner-id.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import type { MigrationExport } from "../shared/schemasMigration.js";

const roots: string[] = [];
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s10-import-"));
	roots.push(dir);
	return dir;
};

const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const envelope = (text: string) => ({
	v: 1 as const,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.from(text.padEnd(16, ".")).toString("base64"),
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("S10 Router import", () => {
	it("prints the resolved relative source path before reading it", () => {
		const dataDir = tempDir();
		const relativeFile = "missing/export.json";
		const result = spawnSync("bun", ["run", path.resolve("scripts/router-import.ts"), "--from", relativeFile], {
			cwd: process.cwd(),
			env: { ...process.env, DATA_DIR: dataDir },
			encoding: "utf8",
		});

		expect(result.stdout.split("\n", 1)[0]).toBe(
			`from ${path.resolve(relativeFile)} data ${path.resolve(dataDir)}`,
		);
		expect(result.status).not.toBe(0);
	});

	it("imports real gateway state idempotently and names a changed epoch digest", async () => {
		const gateway = tempDir();
		const router = tempDir();
		const owner = generateIdentity();
		const ownerSignPub = Buffer.alloc(32, 7).toString("base64");
		const ownerId = ownerKeyId(ownerSignPub);
		const board = new BoardStore(new DurableStore(gateway, "task-board"), new PlaneRegistry(), undefined);
		const attachment = new BoardAttachmentStore(path.join(gateway, "board-attachments"));
		const entryId = "00000000000000000000000000000001";
		const bytes = Buffer.from("attachment bytes");
		const blobId = blobIdFor(bytes);
		const source = path.join(gateway, "source");
		fs.writeFileSync(source, bytes);
		attachment.adopt(ownerId, entryId, blobId, source);
		board.upsert(ownerId, [{ id: entryId, title: "title", state: "open", rank: "m" } as never], OWNER_ACTOR);
		board.setAttachments(
			ownerId,
			entryId,
			[{ blobId, blobGateway: "gateway", filename: "file.txt", size: bytes.length, mime: "text/plain" }],
			OWNER_ACTOR,
		);

		const mailboxes = new DeviceMailboxStore();
		mailboxes.restore({
			[`owner:domain/${ownerSignPub}`]: {
				epoch: 4,
				nextSeq: 10,
				dropped: 0,
				lastActivity: 1,
				entries: [{ seq: 3, at: 1, kind: "message", session_id: "conversation", body: "row" } as never],
				consumerCursors: [["phone", 2]],
			},
			"session:domain/gateway/session": {
				epoch: 4,
				nextSeq: 3,
				dropped: 0,
				lastActivity: 1,
				entries: [
					{ seq: 1, at: 1, kind: "message", session_id: "conversation", body: "one" },
					{ seq: 2, at: 1, kind: "message", session_id: "conversation", body: "two" },
				],
				consumerCursors: [["phone", 0]],
			},
		});
		const pending = new PendingDeliveryStore(new DurableStore(gateway, "pending-deliveries"));
		pending.enqueue({
			deliveryId: "delivery",
			team: "team",
			channelJobId: "job",
			from: "from",
			body: "pending",
			enqueuedAt: 1,
		});
		const shares = new CrossDomainShareState(gateway);
		const snapshot = buildExport(
			{
				domainId: "domain",
				gatewayId: "gateway",
				seal: (text) => envelope(text),
				ownerIds: () => [ownerId],
				boardEntries: (id) => board.allEntries(id),
				holdsSession: () => true,
				mailboxes: () =>
					Object.entries(mailboxes.snapshot()).map(([conversationId, state]) => ({
						conversationId,
						epoch: state.epoch,
						rows: state.entries,
						consumerCursors: state.consumerCursors ?? [],
					})),
				pending: () => pending.snapshot().deliveries,
				readAnchors: () => ({ team: { epoch: 4, seq: 2, at: 1 } }),
				shares: () => shares.all(),
				now: () => 1,
			},
			7,
		);
		for (const mailbox of snapshot.owners[0]!.mailboxes)
			for (const row of mailbox.rows)
				expect(mailbox.cursorMap).toContainEqual({
					oldEpoch: mailbox.epoch,
					oldSeq: row.row.seq,
					epoch: 7,
					seq: expect.any(Number),
				});
		for (const cursor of snapshot.owners[0]!.mailboxes.flatMap((mailbox) => mailbox.consumerCursors))
			expect(snapshot.owners[0]!.mailboxes.flatMap((mailbox) => mailbox.cursorMap)).toContainEqual({
				oldEpoch: expect.any(Number),
				oldSeq: cursor[1],
				epoch: 7,
				seq: expect.any(Number),
			});
		const artifacts = writeBlobArtifacts(
			snapshot,
			gateway,
			(id) => attachment.readAny(id, 0, Number.MAX_SAFE_INTEGER)?.bytes ?? null,
			Buffer.alloc(32),
			ownerSignPub,
		);
		(snapshot as MigrationExport).blobs = artifacts.manifest;
		const exportFile = path.join(gateway, "export-7.json");
		const exportBytes = Buffer.from(JSON.stringify(snapshot, null, "\t"));
		fs.writeFileSync(exportFile, exportBytes);
		fs.writeFileSync(
			path.join(gateway, "SHA256SUMS"),
			`${digest(exportBytes)}  export-7.json\n${digest(Buffer.from(JSON.stringify(artifacts.manifest, null, "\t")))}  blobs.json\n`,
		);
		fs.mkdirSync(path.join(router, "owner"), { recursive: true });
		fs.writeFileSync(
			path.join(router, "federation.json"),
			JSON.stringify({
				identity: generateIdentity(),
				enrollment: { domain: { ownerSignPub, ownerBoxPub: owner.box.pub, admissions: [], revocations: [] } },
			}),
		);
		fs.writeFileSync(path.join(router, "router-cert.pem"), "cert");
		fs.writeFileSync(path.join(router, "router-key.pem"), "key");
		const routerIdentity = generateIdentity();
		fs.writeFileSync(
			path.join(router, "federation.json"),
			JSON.stringify({
				identity: routerIdentity,
				enrollment: { domain: { ownerSignPub, ownerBoxPub: owner.box.pub, admissions: [], revocations: [] } },
			}),
		);
		const run = () => {
			const bytes = fs.readFileSync(exportFile);
			const value = JSON.parse(bytes.toString("utf8")) as MigrationExport;
			const digestValue = digest(bytes);
			const markerFile = path.join(router, "import-marker.json");
			const markers = fs.existsSync(markerFile)
				? (JSON.parse(fs.readFileSync(markerFile, "utf8")) as Record<string, ImportMarker>)
				: {};
			const key = markerKey(value.gatewayId, value.epoch);
			const verdict = decideImport(
				{ digest: digestValue, epoch: value.epoch, gatewayId: value.gatewayId },
				markers[key],
			);
			if (verdict.kind === "noop") return verdict.marker;
			if (verdict.kind === "refused") throw new Error(`epoch conflict: ${JSON.stringify(verdict.recorded)}`);
			const store = OwnerStateStore.open({
				dataDir: router,
				key: { domainId: "domain", ownerSignPub },
				quota: new DomainQuota({ dir: router, limitBytes: 1_000_000_000, reserveBytes: 0 }),
			});
			try {
				applyImport(store, value, ownerSignPub, dedupeRows, routerIdentity.sign.priv, routerIdentity.sign.pub);
				if (value.blobs?.length)
					importBlobArtifacts(gateway, new ReferenceHeldStore({ dataDir: router }), value, value.blobs);
			} finally {
				store.close();
			}
			const marker = {
				digest: digestValue,
				epoch: value.epoch,
				gatewayId: value.gatewayId,
				counts: { owners: value.owners.length },
			};
			markers[key] = marker;
			writeFileAtomic(markerFile, JSON.stringify(markers), { mode: 0o600 });
			return marker;
		};
		const first = run();
		const tree = (dir: string): string[] =>
			fs
				.readdirSync(dir, { recursive: true, encoding: "utf8" })
				.filter((name) => fs.statSync(path.join(dir, name)).isFile())
				.sort()
				.map((name) => `${name}:${fs.readFileSync(path.join(dir, name), "utf8")}`);
		const before = tree(path.join(router, "owner"));
		const second = run();
		expect(tree(path.join(router, "owner"))).toEqual(before);
		expect(second).toEqual(first);
		const reopened = OwnerStateStore.open({
			dataDir: router,
			key: { domainId: "domain", ownerSignPub },
			quota: new DomainQuota({ dir: router, limitBytes: 1_000_000_000, reserveBytes: 0 }),
		});
		let translate: ((op: never, value: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
		createCursorService({ registry: { for: () => reopened } as never, migrationEpoch: () => 7 }).register({
			ownerOp: (_kind: string, handler: OwnerOpHandler) => {
				translate = handler;
			},
		} as never);
		const cursorInput = { address: `owner:domain/${ownerSignPub}`, epoch: 4, seq: 2 };
		const cursorAnswer = await translate!({ domainId: "domain" } as never, cursorInput);
		expect(await translate!({ domainId: "domain" } as never, cursorInput)).toEqual(cursorAnswer);
		reopened.close();
		const changed = {
			...snapshot,
			owners: snapshot.owners.map((value) => ({ ...value, readAnchors: { changed: true } })),
		};
		const changedBytes = Buffer.from(JSON.stringify(changed, null, "\t"));
		fs.writeFileSync(exportFile, changedBytes);
		fs.writeFileSync(path.join(gateway, "SHA256SUMS"), `${digest(changedBytes)}  export-7.json\n`);
		expect(() => run()).toThrow(new RegExp(`epoch conflict.*${digest(exportBytes)}`));
	});
});
