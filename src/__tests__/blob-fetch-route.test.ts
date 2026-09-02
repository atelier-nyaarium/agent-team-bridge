import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { BlobFetchRoute } from "../federation-server/inbox/blobFetchRoute.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES } from "../shared/router-protocol.js";
import { sealBlobChunk, sealedBlobChunkCount } from "../shared/sealed-blob.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-route-"));
	roots.push(dataDir);
	return new RouterBlobCache({ dataDir, quotaBytesPerDomain: 4_000_000 });
}

function fill(cache: RouterBlobCache, bytes: Buffer) {
	const blobId = blobIdFor(bytes);
	const frames: Buffer[] = [];
	for (let index = 0; index < sealedBlobChunkCount(bytes.length); index++) {
		frames.push(
			sealBlobChunk(
				bytes.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES),
				Buffer.alloc(32, 3),
				{ domainId: "domain", ownerSignPub: "owner", epoch: 4, blobId },
				index,
				index + 1 === sealedBlobChunkCount(bytes.length),
			),
		);
	}
	const ciphertext = Buffer.concat(frames);
	const digest = `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`;
	const begun = cache.begin(
		"domain",
		blobId,
		{ domainId: "origin", gatewayId: "gateway" },
		bytes.length,
		ciphertext.length,
		digest,
		4,
	);
	if (begun.kind !== "lease") throw new Error("expected lease");
	cache.commitChunk("domain", blobId, begun.lease, 0, ciphertext, true);
	return { blobId, frames };
}

describe("BlobFetchRoute", () => {
	it("rounds a straddling plaintext range to whole sealed chunks", async () => {
		const cache = setup();
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES + 20, 5);
		const { blobId, frames } = fill(cache, bytes);
		const route = new BlobFetchRoute(cache, () => null);
		await expect(
			route.fetch("domain", {
				opId: "op",
				blobId,
				range: { offset: BLOB_CHUNK_BYTES - 5, length: 10 },
				incarnation: 1,
			}),
		).resolves.toEqual({
			outcome: "fetched",
			bytes: Buffer.concat(frames).toString("base64"),
			eof: false,
			sealed: true,
			epoch: 4,
			offset: 0,
			size: bytes.length,
		});
	});

	it("declares origin fallback bytes as clear", async () => {
		const cache = setup();
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
			route.settle("c1", {
				opId: "op",
				outcome: "fetched",
				bytes: "ok",
				eof: true,
				sealed: false,
				incarnation: 2,
			}),
		).toBe(true);
		await expect(pending).resolves.toEqual({ outcome: "fetched", bytes: "ok", eof: true, sealed: false });
	});

	it("forwards misses and settles only the connected origin reply", async () => {
		const cache = setup();
		const send = vi.fn();
		const route = new BlobFetchRoute(cache, () => ({ connId: "c1", send }));
		const blobId = blobIdFor(Buffer.from("origin"));
		const pending = route.fetch("domain", {
			opId: "op",
			blobId,
			origin: { domainId: "origin", gatewayId: "gateway" },
			incarnation: 2,
		});
		expect(
			route.settle("other", {
				opId: "op",
				outcome: "fetched",
				bytes: "bad",
				eof: false,
				sealed: false,
				incarnation: 2,
			}),
		).toBe(false);
		expect(
			route.settle("c1", {
				opId: "op",
				outcome: "fetched",
				bytes: "ok",
				eof: true,
				sealed: false,
				incarnation: 2,
			}),
		).toBe(true);
		await expect(pending).resolves.toEqual({ outcome: "fetched", bytes: "ok", eof: true, sealed: false });
		expect(
			route.settle("c1", {
				opId: "op",
				outcome: "fetched",
				bytes: "late",
				eof: true,
				sealed: false,
				incarnation: 2,
			}),
		).toBe(false);
	});

	it("answers unreachable and timeout without retaining a pending request", async () => {
		const cache = setup();
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
		const cache = setup();
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
