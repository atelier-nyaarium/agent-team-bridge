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
});
