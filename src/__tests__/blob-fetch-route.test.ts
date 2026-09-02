import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { BlobFetchRoute } from "../federation-server/inbox/blobFetchRoute.js";
import { blobIdFor } from "../shared/blob-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-route-"));
	roots.push(dataDir);
	const cache = new RouterBlobCache({ dataDir, quotaBytesPerDomain: 100 });
	return { cache, dataDir };
}

describe("BlobFetchRoute", () => {
	it("answers a cache hit with the requested range and eof", () => {
		const { cache } = setup();
		const bytes = Buffer.from("abcdef");
		const blobId = blobIdFor(bytes);
		const lease = cache.begin("domain", blobId, { domainId: "origin", gatewayId: "gateway" }, bytes.length);
		if (lease.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", blobId, lease.lease, 0, bytes, true);
		const route = new BlobFetchRoute(cache, () => null);

		return expect(
			route.fetch("domain", { opId: "op", blobId, range: { offset: 2, length: 3 }, incarnation: 1 }),
		).resolves.toEqual({
			outcome: "fetched",
			bytes: Buffer.from("cde").toString("base64"),
			eof: false,
		});
	});

	it("forwards misses and settles only the connected origin reply", async () => {
		const { cache } = setup();
		const send = vi.fn();
		const route = new BlobFetchRoute(cache, () => ({ connId: "c1", send }));
		const blobId = blobIdFor(Buffer.from("origin"));
		const pending = route.fetch("domain", {
			opId: "op",
			blobId,
			origin: { domainId: "origin", gatewayId: "gateway" },
			incarnation: 2,
		});
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "blob_fetch", opId: "op" }));
		expect(
			route.settle("other", { opId: "op", outcome: "fetched", bytes: "bad", eof: false, incarnation: 2 }),
		).toBe(false);
		expect(route.settle("c1", { opId: "op", outcome: "fetched", bytes: "ok", eof: true, incarnation: 2 })).toBe(
			true,
		);
		await expect(pending).resolves.toEqual({ outcome: "fetched", bytes: "ok", eof: true });
		expect(route.settle("c1", { opId: "op", outcome: "fetched", bytes: "late", eof: true, incarnation: 2 })).toBe(
			false,
		);
	});

	it("answers unreachable and timeout without retaining a pending request", async () => {
		const { cache } = setup();
		const absent = new BlobFetchRoute(cache, () => null);
		const blobId = blobIdFor(Buffer.from("missing"));
		await expect(absent.fetch("domain", { opId: "absent", blobId, incarnation: 1 })).resolves.toEqual({
			outcome: "absent",
		});
		const route = new BlobFetchRoute(cache, () => ({ connId: "c1", send: () => undefined }), 5);
		await expect(
			route.fetch("domain", {
				opId: "timeout",
				blobId,
				origin: { domainId: "origin", gatewayId: "gateway" },
				incarnation: 1,
			}),
		).resolves.toEqual({ outcome: "timeout" });
	});

	it("answers unreachable when the origin connection disconnects", async () => {
		const { cache } = setup();
		const route = new BlobFetchRoute(cache, () => ({ connId: "origin", send: () => undefined }));
		const pending = route.fetch("domain", {
			opId: "disconnect",
			blobId: blobIdFor(Buffer.from("disconnect")),
			origin: { domainId: "origin", gatewayId: "gateway" },
			incarnation: 1,
		});
		route.failConnection("origin");
		await expect(pending).resolves.toEqual({ outcome: "unreachable" });
	});
});
