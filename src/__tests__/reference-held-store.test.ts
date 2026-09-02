import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { blobIdFor } from "../shared/blob-store.js";

describe("ReferenceHeldStore", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("keeps a blob until the last reference is released", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root });
		const bytes = Buffer.from("held bytes");
		const blobId = blobIdFor(bytes);
		const entry = { kind: "entry" as const, id: "entry-1" };
		const row = { kind: "row" as const, id: "row-1" };
		store.hold("domain", blobId, entry);
		store.hold("domain", blobId, row);
		const lease = store.begin("domain", blobId);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, bytes, true);

		expect(store.has("domain", blobId)).toBe(true);
		store.release("domain", blobId, entry);
		expect(store.refs("domain", blobId)).toEqual([row]);
		store.release("domain", blobId, row);
		expect(store.has("domain", blobId)).toBe(false);
	});

	it("does not answer held for a reference whose bytes never finished arriving", () => {
		// A begin takes the reference first, so refs alone would let a board entry name a dead file.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root });
		const bytes = Buffer.from("half a file arrives");
		const blobId = blobIdFor(bytes);
		store.hold("domain", blobId, { kind: "entry", id: "entry-1" });

		expect(store.has("domain", blobId)).toBe(false);
		const lease = store.begin("domain", blobId);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, bytes.subarray(0, 4), false);
		expect(store.has("domain", blobId)).toBe(false);

		store.commitChunk("domain", blobId, lease.lease, 4, bytes.subarray(4), true);
		expect(store.has("domain", blobId)).toBe(true);
	});

	it("reconcile removes dead references and orphaned blobs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root });
		const bytes = Buffer.from("reconcile");
		const blobId = blobIdFor(bytes);
		const live = { kind: "scheduled" as const, id: "live" };
		const dead = { kind: "row" as const, id: "dead" };
		store.hold("domain", blobId, live);
		store.hold("domain", blobId, dead);
		const lease = store.begin("domain", blobId);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, bytes, true);
		store.reconcile("domain", (ref) => ref.id === "live");
		expect(store.refs("domain", blobId)).toEqual([live]);
		store.reconcile("domain", () => false);
		expect(store.has("domain", blobId)).toBe(false);
	});

	it("reconcile removes unfinished uploads with dead references", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
		roots.push(root);
		const store = new ReferenceHeldStore({ dataDir: root });
		const blobId = blobIdFor(Buffer.from("unfinished"));
		store.hold("domain", blobId, { kind: "entry", id: "gone" });
		const lease = store.begin("domain", blobId);
		if (lease.kind !== "lease") throw new Error("expected lease");
		store.commitChunk("domain", blobId, lease.lease, 0, Buffer.from("part"), false);

		store.reconcile("domain", () => false);
		expect(store.refs("domain", blobId)).toEqual([]);
		expect(store.has("domain", blobId)).toBe(false);
	});
});
