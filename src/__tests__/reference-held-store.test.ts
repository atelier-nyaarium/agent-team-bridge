import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorruptHeldIndexError, ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { processAmbient } from "../shared/ambient.js";
import type { BlobReference } from "../shared/blob-reference.js";
import { blobIdFor } from "../shared/blob-store.js";
import { sealBlobChunk } from "../shared/sealed-blob.js";

describe("ReferenceHeldStore", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("keeps verified ciphertext until the last reference is released", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("held bytes");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		const entry: BlobReference = { kind: "entry", entryId: "entry-1" };
		const row: BlobReference = {
			kind: "row",
			address: { kind: "gateway", domainId: "domain", gatewayId: "gateway" },
			seq: 1,
		};
		store.applyRefs("domain", [
			{ ref: entry, blobIds: [blobId] },
			{ ref: row, blobIds: [blobId] },
		]);
		const begun = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (begun.kind !== "lease") throw new Error("expected lease");
		expect(store.commitChunk("domain", blobId, begun.lease, 0, bytes, true)).toMatchObject({ complete: true });
		store.applyRefs("domain", [{ ref: entry, blobIds: [] }]);
		expect(store.has("domain", blobId)).toBe(true);
		store.applyRefs("domain", [{ ref: row, blobIds: [] }]);
		expect(store.has("domain", blobId)).toBe(false);
	});

	it("reconcile removes unfinished uploads with dead references", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("unfinished");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		store.applyRefs("domain", [{ ref: { kind: "entry", entryId: "gone" }, blobIds: [blobId] }]);
		const begun = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (begun.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, begun.lease, 0, bytes.subarray(0, 4), false);
		store.reconcile("domain", () => false);
		expect(store.refs("domain", blobId)).toEqual([]);
		expect(store.has("domain", blobId)).toBe(false);
	});

	it("does not answer held for a reference whose bytes never finished arriving", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("half a file arrives");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		store.applyRefs("domain", [{ ref: { kind: "entry", entryId: "entry-1" }, blobIds: [blobId] }]);
		expect(store.has("domain", blobId)).toBe(false);
		const begun = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (begun.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, begun.lease, 0, bytes.subarray(0, 4), false);
		expect(store.has("domain", blobId)).toBe(false);
		store.commitChunk("domain", blobId, begun.lease, 4, bytes.subarray(4), true);
		expect(store.has("domain", blobId)).toBe(true);
	});

	it("reconcile removes dead references and orphaned blobs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("reconcile");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		const live: BlobReference = {
			kind: "scheduled",
			target: { domainId: "domain", gatewayId: "gateway", sessionId: "live" },
		};
		const dead: BlobReference = {
			kind: "row",
			address: { kind: "gateway", domainId: "domain", gatewayId: "gateway" },
			seq: 2,
		};
		store.applyRefs("domain", [
			{ ref: live, blobIds: [blobId] },
			{ ref: dead, blobIds: [blobId] },
		]);
		const begun = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (begun.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, begun.lease, 0, bytes, true);
		store.reconcile("domain", (ref) => ref.kind === "scheduled");
		expect(store.refs("domain", blobId)).toEqual([live]);
		store.reconcile("domain", () => false);
		expect(store.has("domain", blobId)).toBe(false);
	});

	it("replacing one reference with a larger set keeps existing bytes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("replace");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		const ref: BlobReference = { kind: "entry", entryId: "entry" };
		store.applyRefs("domain", [{ ref, blobIds: [blobId] }]);
		const lease = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, bytes, true);
		store.applyRefs("domain", [{ ref, blobIds: [blobId, "another"] }]);
		expect(store.has("domain", blobId)).toBe(true);
	});

	it("moves one blob between references in one batch without deleting it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		const plain = Buffer.from("move");
		const blobId = blobIdFor(plain);
		const bytes = sealBlobChunk(
			plain,
			Buffer.alloc(32, 4),
			{ domainId: "domain", ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
		const from: BlobReference = { kind: "entry", entryId: "from" };
		const to: BlobReference = { kind: "entry", entryId: "to" };
		store.applyRefs("domain", [{ ref: from, blobIds: [blobId] }]);
		const lease = store.begin("domain", blobId, plain.length, bytes.length, digest, 1);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, bytes, true);
		store.applyRefs("domain", [
			{ ref: from, blobIds: [] },
			{ ref: to, blobIds: [blobId] },
		]);
		expect(store.has("domain", blobId)).toBe(true);
		expect(store.refs("domain", blobId)).toEqual([to]);
	});

	it("keeps an unparseable stored reference and logs it during reconcile", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const indexDir = path.join(root, "blobs", "domain", "held");
		fs.mkdirSync(indexDir, { recursive: true });
		fs.writeFileSync(
			path.join(indexDir, "index.json"),
			JSON.stringify({ entries: { blob: { refs: ["not-a-reference"] } } }),
		);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		store.reconcile("domain", () => false);
		expect(warning).toHaveBeenCalledWith("[router] unknown blob reference not-a-reference");
		expect(JSON.parse(fs.readFileSync(path.join(indexDir, "index.json"), "utf8")).entries.blob.refs).toEqual([
			"not-a-reference",
		]);
		warning.mockRestore();
	});

	it("keeps the index quarantined across repeated opens", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const file = path.join(root, "blobs", "domain", "held", "index.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "corrupt");
		const store = new ReferenceHeldStore({ dataDir: root, ambient: processAmbient() });
		let first: unknown;
		try {
			store.refs("domain", `sha256-${"0".repeat(64)}`);
		} catch (error) {
			first = error;
		}
		expect(first).toBeInstanceOf(CorruptHeldIndexError);
		expect(() => store.refs("domain", `sha256-${"0".repeat(64)}`)).toThrow(CorruptHeldIndexError);
		expect(fs.existsSync(file)).toBe(false);
	});
});
