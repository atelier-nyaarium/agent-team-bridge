import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, BlobChunkParamsSchema } from "../shared/router-protocol.js";
import { sealBlobChunk, sealedBlobChunkCount, sealedBlobSize } from "../shared/sealed-blob.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const key = Buffer.alloc(32, 9);
const contextBase = { domainId: "domain", ownerSignPub: "owner", epoch: 2 };

function sealBlob(bytes: Buffer, blobId = blobIdFor(bytes)) {
	const frames: Buffer[] = [];
	for (let index = 0; index < sealedBlobChunkCount(bytes.length); index++) {
		const plain = bytes.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES);
		frames.push(
			sealBlobChunk(
				plain,
				key,
				{ ...contextBase, blobId },
				index,
				index + 1 === sealedBlobChunkCount(bytes.length),
			),
		);
	}
	const ciphertext = Buffer.concat(frames);
	return {
		ciphertext,
		ciphertextDigest: `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`,
	};
}

describe("RouterBlobCache", () => {
	const roots: string[] = [];
	let clock = 1_000;
	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
		clock = 1_000;
	});

	function make(quotaBytesPerDomain = 3_000_000) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-"));
		roots.push(dataDir);
		return new RouterBlobCache({ dataDir, quotaBytesPerDomain, ambient: fakeAmbient({ now: () => clock }) });
	}

	function begin(cache: RouterBlobCache, bytes: Buffer, blobId = blobIdFor(bytes)) {
		const sealed = sealBlob(bytes, blobId);
		const begun = cache.begin(
			"domain",
			blobId,
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			sealed.ciphertext.length,
			sealed.ciphertextDigest,
			2,
		);
		if (begun.kind !== "lease") throw new Error("expected lease");
		return { ...sealed, lease: begun.lease };
	}

	it("verifies ciphertext and records plaintext metadata", () => {
		const cache = make();
		const bytes = Buffer.from("cache bytes");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		expect(cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext, true)).toEqual({
			have: sealed.ciphertext.length,
			complete: true,
		});
		expect(cache.stat("domain", blobId)).toMatchObject({
			kind: "complete",
			size: bytes.length,
			ciphertextSize: sealedBlobSize(bytes.length),
			epoch: 2,
		});
		expect(cache.read("domain", blobId, 0, sealed.ciphertext.length)).toEqual(sealed.ciphertext);
	});

	it("rejects a truncated final upload", () => {
		const cache = make();
		const bytes = Buffer.from("truncated");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		expect(cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext.subarray(0, -1), true)).toEqual({
			kind: "size_mismatch",
		});
		expect(cache.stat("domain", blobId).kind).toBe("miss");
	});

	it("rejects a ciphertext digest mismatch without changing plaintext stores", () => {
		const cache = make();
		const bytes = Buffer.from("tampered");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		sealed.ciphertext[sealed.ciphertext.length - 1] ^= 1;
		expect(cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext, true)).toEqual({
			have: sealed.ciphertext.length,
			complete: false,
		});
	});

	it("reserves declared ciphertext against concurrent uploads", () => {
		const bytes = Buffer.alloc(40, 1);
		const firstSealed = sealBlob(bytes);
		const cache = make(firstSealed.ciphertext.length + 10);
		const first = cache.begin(
			"domain",
			blobIdFor(bytes),
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			firstSealed.ciphertext.length,
			firstSealed.ciphertextDigest,
			2,
		);
		expect(first.kind).toBe("lease");
		const other = Buffer.alloc(20, 2);
		const otherSealed = sealBlob(other);
		expect(
			cache.begin(
				"domain",
				blobIdFor(other),
				{ domainId: "domain", gatewayId: "gateway" },
				other.length,
				otherSealed.ciphertext.length,
				otherSealed.ciphertextDigest,
				2,
			),
		).toEqual({ kind: "quota" });
	});

	it("rejects stale generations and ciphertext gaps", () => {
		const cache = make();
		const bytes = Buffer.from("generation");
		const blobId = blobIdFor(bytes);
		const sealed = sealBlob(bytes);
		const first = cache.begin(
			"domain",
			blobId,
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			sealed.ciphertext.length,
			sealed.ciphertextDigest,
			2,
		);
		const second = cache.begin(
			"domain",
			blobId,
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			sealed.ciphertext.length,
			sealed.ciphertextDigest,
			2,
		);
		if (first.kind !== "lease" || second.kind !== "lease") throw new Error("expected leases");
		expect(cache.commitChunk("domain", blobId, first.lease, 0, sealed.ciphertext, true)).toEqual({
			kind: "generation_mismatch",
		});
		expect(cache.commitChunk("domain", blobId, second.lease, 1, sealed.ciphertext, false)).toEqual({
			kind: "gap",
		});
	});

	it("refuses an expired lease and reclaims its partial", () => {
		const cache = make();
		const bytes = Buffer.from("expired");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		expect(cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext.subarray(0, 2), false)).toEqual({
			have: 2,
			complete: false,
		});
		clock += 10 * 60 * 1_000;
		expect(cache.commitChunk("domain", blobId, sealed.lease, 2, sealed.ciphertext.subarray(2), true)).toEqual({
			kind: "lease_expired",
		});
		cache.sweep(clock);
		expect(cache.stat("domain", blobId)).toEqual({
			kind: "miss",
			origin: { domainId: "domain", gatewayId: "gateway" },
		});
	});

	it("strips an expired lease down to a retained origin", () => {
		const cache = make();
		const dataDir = roots[roots.length - 1];
		const bytes = Buffer.from("expired sidecar");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext.subarray(0, 2), false);
		const hash = blobId.slice("sha256-".length);
		const sidecar = path.join(dataDir, "blob-cache-metadata", "domain", hash.slice(0, 2), `${hash}.json`);
		expect(fs.existsSync(sidecar)).toBe(true);

		clock += 10 * 60 * 1_000;
		cache.sweep(clock);

		expect(fs.existsSync(sidecar)).toBe(false);
		const index = JSON.parse(
			fs.readFileSync(path.join(dataDir, "blobs", "domain", "cache", "index.json"), "utf8"),
		) as { entries: Record<string, { size?: number; ciphertextDigest?: string; epoch?: number }> };
		expect(index.entries[blobId]).toEqual({ lastReadAt: expect.any(Number), origin: expect.any(Object) });
	});

	it("evicts the coldest complete entry but preserves a live transfer", () => {
		const cache = make(70);
		const oldBytes = Buffer.from("old");
		const oldId = blobIdFor(oldBytes);
		const old = begin(cache, oldBytes);
		cache.commitChunk("domain", oldId, old.lease, 0, old.ciphertext, true);
		clock++;
		const liveBytes = Buffer.from("live");
		const liveId = blobIdFor(liveBytes);
		const live = begin(cache, liveBytes);
		cache.commitChunk("domain", liveId, live.lease, 0, live.ciphertext.subarray(0, 3), false);
		const nextBytes = Buffer.from("next");
		const next = begin(cache, nextBytes);

		expect(cache.stat("domain", oldId)).toEqual({
			kind: "miss",
			origin: { domainId: "domain", gatewayId: "gateway" },
		});
		expect(cache.stat("domain", liveId).kind).toBe("miss");
		expect(cache.commitChunk("domain", liveId, live.lease, 3, live.ciphertext.subarray(3), true)).toEqual({
			have: live.ciphertext.length,
			complete: true,
		});
		expect(next.lease.expectedSize).toBe(sealedBlobSize(nextBytes.length));
	});

	it("rebuilds complete entries when the index is lost", () => {
		const cache = make();
		const bytes = Buffer.from("rebuild");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		cache.commitChunk("domain", blobId, sealed.lease, 0, sealed.ciphertext, true);
		fs.rmSync(path.join(roots[0], "blobs", "domain", "cache", "index.json"));

		const rebuilt = new RouterBlobCache({
			dataDir: roots[0],
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		});
		expect(rebuilt.stat("domain", blobId)).toMatchObject({
			kind: "complete",
			size: bytes.length,
			ciphertextSize: sealed.ciphertext.length,
			epoch: 2,
		});
	});

	it("removes ciphertext and logs an unreadable recovery sidecar", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-sidecar-"));
		roots.push(dataDir);
		const bytes = Buffer.from("unreadable recovery");
		const blobId = blobIdFor(bytes);
		const sealed = sealBlob(bytes, blobId);
		const cache = new RouterBlobCache({
			dataDir,
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		});
		const begun = cache.begin(
			"domain",
			blobId,
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			sealed.ciphertext.length,
			sealed.ciphertextDigest,
			2,
		);
		if (begun.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", blobId, begun.lease, 0, sealed.ciphertext, true);
		fs.rmSync(path.join(dataDir, "blobs", "domain", "cache", "index.json"));
		const hash = blobId.slice("sha256-".length);
		const ciphertext = path.join(dataDir, "blobs", "domain", "cache", hash.slice(0, 2), hash);
		const sidecar = path.join(dataDir, "blob-cache-metadata", "domain", hash.slice(0, 2), `${hash}.json`);
		fs.rmSync(sidecar);
		fs.mkdirSync(sidecar);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		new RouterBlobCache({
			dataDir,
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		}).stat("domain", blobId);
		expect(fs.existsSync(ciphertext)).toBe(false);
		expect(fs.existsSync(sidecar)).toBe(false);
		expect(warning).toHaveBeenCalledWith(`[router-blob-cache] unreadable recovery ${blobId}`);
		warning.mockRestore();
	});

	it("refuses a chunk that crosses the blob ceiling", () => {
		const cache = make();
		const bytes = Buffer.from("oversize");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		expect(
			cache.commitChunk("domain", blobId, sealed.lease, sealedBlobSize(500_000_000), Buffer.from("x"), false),
		).toEqual({ kind: "too_large" });
	});

	it("refuses a chunk that crosses the declared size", () => {
		const cache = make();
		const bytes = Buffer.from("declared");
		const blobId = blobIdFor(bytes);
		const sealed = begin(cache, bytes);
		expect(
			cache.commitChunk(
				"domain",
				blobId,
				sealed.lease,
				0,
				Buffer.concat([sealed.ciphertext, Buffer.from("x")]),
				true,
			),
		).toEqual({ kind: "too_large" });
	});

	it("keeps a complete file whose lease was persisted before a crash", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-reopen-"));
		roots.push(dataDir);
		const bytes = Buffer.from("crash complete");
		const blobId = blobIdFor(bytes);
		const sealed = sealBlob(bytes);
		const cache = new RouterBlobCache({
			dataDir,
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		});
		const begun = cache.begin(
			"domain",
			blobId,
			{ domainId: "domain", gatewayId: "gateway" },
			bytes.length,
			sealed.ciphertext.length,
			sealed.ciphertextDigest,
			2,
		);
		if (begun.kind !== "lease") throw new Error("expected lease");
		const hash = blobId.slice("sha256-".length);
		const complete = path.join(dataDir, "blobs", "domain", "cache", hash.slice(0, 2), hash);
		fs.mkdirSync(path.dirname(complete), { recursive: true });
		fs.writeFileSync(complete, sealed.ciphertext);

		const reopened = new RouterBlobCache({
			dataDir,
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		});
		expect(reopened.stat("domain", blobId)).toMatchObject({
			kind: "complete",
			size: bytes.length,
			origin: { domainId: "domain", gatewayId: "gateway" },
		});
	});

	it("removes unleased partial files on open", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-orphan-"));
		roots.push(dataDir);
		const blobId = blobIdFor(Buffer.from("orphan"));
		const hash = blobId.slice("sha256-".length);
		const part = path.join(dataDir, "blobs", "domain", "cache", hash.slice(0, 2), `${hash}.part`);
		fs.mkdirSync(path.dirname(part), { recursive: true });
		fs.writeFileSync(part, "partial");
		const cache = new RouterBlobCache({
			dataDir,
			quotaBytesPerDomain: 3_000_000,
			ambient: fakeAmbient({ now: () => clock }),
		});
		cache.stat("domain", blobId);
		expect(fs.existsSync(part)).toBe(false);
	});

	it("discards a partial from an attempt that declared a different ciphertext", () => {
		const cache = make();
		const bytes = Buffer.from("interrupted upload");
		const blobId = blobIdFor(bytes);
		const first = begin(cache, bytes);
		cache.commitChunk("domain", blobId, first.lease, 0, first.ciphertext.subarray(0, 8), false);

		const second = begin(cache, bytes);
		expect(cache.commitChunk("domain", blobId, second.lease, 0, second.ciphertext, true)).toEqual({
			have: second.ciphertext.length,
			complete: true,
		});
		expect(cache.stat("domain", blobId).kind).toBe("complete");
	});

	it("bounds encoded sealed chunks", () => {
		const base = {
			blobId: blobIdFor(Buffer.from("x")),
			store: "cache" as const,
			lease: { id: "lease", generation: 1 },
			offset: 0,
			final: false,
			incarnation: 1,
		};
		expect(
			BlobChunkParamsSchema.safeParse({ ...base, bytes: "A".repeat((BLOB_CHUNK_BYTES + 28) * 2) }).success,
		).toBe(true);
		expect(
			BlobChunkParamsSchema.safeParse({ ...base, bytes: "A".repeat((BLOB_CHUNK_BYTES + 28) * 2 + 1) }).success,
		).toBe(false);
	});
});
