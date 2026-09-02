import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterBlobCache } from "../federation-server/blobs/routerBlobCache.js";
import { blobIdFor } from "../shared/blob-store.js";

describe("RouterBlobCache", () => {
	const roots: string[] = [];
	let clock = 1_000;

	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	function make(quotaBytesPerDomain = 100) {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-"));
		roots.push(dataDir);
		return new RouterBlobCache({ dataDir, quotaBytesPerDomain, now: () => clock });
	}

	function origin() {
		return { domainId: "domain", gatewayId: "gateway" };
	}

	it("seals chunks and records the origin", () => {
		const cache = make();
		const bytes = Buffer.from("cache bytes");
		const blobId = blobIdFor(bytes);
		const begun = cache.begin("domain", blobId, origin(), bytes.length);
		if (begun.kind !== "lease") throw new Error("expected lease");

		expect(cache.commitChunk("domain", blobId, begun.lease, 0, bytes, true)).toEqual({
			have: bytes.length,
			complete: true,
		});
		expect(cache.stat("domain", blobId)).toMatchObject({ kind: "complete", size: bytes.length, origin: origin() });
		expect(cache.read("domain", blobId, 0, bytes.length)).toEqual(bytes);
	});

	it("refuses an expired lease and reclaims its partial", () => {
		const cache = make();
		const bytes = Buffer.from("expired");
		const blobId = blobIdFor(bytes);
		const begun = cache.begin("domain", blobId, origin(), bytes.length);
		if (begun.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", blobId, begun.lease, 0, bytes.subarray(0, 2), false);
		clock += 10 * 60 * 1000;
		expect(cache.commitChunk("domain", blobId, begun.lease, 2, bytes.subarray(2), true)).toEqual({
			kind: "lease_expired",
		});
		cache.sweep(clock);
		expect(cache.stat("domain", blobId)).toEqual({ kind: "miss", origin: origin() });
	});

	it("rejects stale generations and gaps", () => {
		const cache = make();
		const bytes = Buffer.from("generation");
		const blobId = blobIdFor(bytes);
		const first = cache.begin("domain", blobId, origin(), bytes.length);
		if (first.kind !== "lease") throw new Error("expected lease");
		const second = cache.begin("domain", blobId, origin(), bytes.length);
		if (second.kind !== "lease") throw new Error("expected lease");
		expect(cache.commitChunk("domain", blobId, first.lease, 0, bytes, true)).toEqual({
			kind: "generation_mismatch",
		});
		expect(cache.commitChunk("domain", blobId, second.lease, 2, bytes, false)).toEqual({ kind: "gap" });
	});

	it("evicts the coldest complete entry but preserves a live transfer", () => {
		const cache = make(10);
		const oldBytes = Buffer.from("old");
		const oldId = blobIdFor(oldBytes);
		const old = cache.begin("domain", oldId, origin(), oldBytes.length);
		if (old.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", oldId, old.lease, 0, oldBytes, true);
		clock++;
		const liveBytes = Buffer.from("live");
		const liveId = blobIdFor(liveBytes);
		const live = cache.begin("domain", liveId, origin(), liveBytes.length);
		if (live.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", liveId, live.lease, 0, liveBytes, false);
		const newBytes = Buffer.from("next");
		const newId = blobIdFor(newBytes);
		const next = cache.begin("domain", newId, origin(), newBytes.length);
		if (next.kind !== "lease") throw new Error("expected lease");

		expect(cache.stat("domain", oldId).kind).toBe("miss");
		expect(cache.stat("domain", liveId).kind).toBe("miss");
		expect(cache.commitChunk("domain", liveId, live.lease, 3, Buffer.from("!"), true)).toEqual({
			have: 4,
			complete: true,
		});
	});

	it("rebuilds complete entries when the index is lost", () => {
		const cache = make();
		const bytes = Buffer.from("rebuild");
		const blobId = blobIdFor(bytes);
		const lease = cache.begin("domain", blobId, origin(), bytes.length);
		if (lease.kind !== "lease") throw new Error("expected lease");
		cache.commitChunk("domain", blobId, lease.lease, 0, bytes, true);
		const index = path.join(roots[0], "blobs", "domain", "cache", "index.json");
		fs.rmSync(index);
		const rebuilt = new RouterBlobCache({ dataDir: roots[0], quotaBytesPerDomain: 100, now: () => clock });
		expect(rebuilt.stat("domain", blobId)).toMatchObject({ kind: "complete", size: bytes.length });
	});

	it("refuses a chunk that crosses the blob ceiling", () => {
		const cache = make();
		const blobId = blobIdFor(Buffer.from("oversize"));
		const lease = cache.begin("domain", blobId, origin(), 8);
		if (lease.kind !== "lease") throw new Error("expected lease");
		expect(cache.commitChunk("domain", blobId, lease.lease, 500_000_000, Buffer.from("x"), false)).toEqual({
			kind: "too_large",
		});
	});

	it("keeps a complete file whose lease was persisted before a crash", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-reopen-"));
		roots.push(dataDir);
		const bytes = Buffer.from("crash complete");
		const blobId = blobIdFor(bytes);
		const hash = blobId.slice("sha256-".length);
		const cacheDir = path.join(dataDir, "blobs", "domain", "cache");
		fs.mkdirSync(path.join(cacheDir, hash.slice(0, 2)), { recursive: true });
		fs.writeFileSync(path.join(cacheDir, hash.slice(0, 2), hash), bytes);
		fs.writeFileSync(
			path.join(cacheDir, "index.json"),
			JSON.stringify({
				entries: {
					[blobId]: {
						origin: origin(),
						lastReadAt: clock,
						lease: { id: "lease", generation: 1, expiresAt: clock + 1, lastRenewedAt: clock },
					},
				},
			}),
		);
		const reopened = new RouterBlobCache({ dataDir, quotaBytesPerDomain: 100, now: () => clock + 1 });
		expect(reopened.stat("domain", blobId)).toMatchObject({
			kind: "complete",
			size: bytes.length,
			origin: origin(),
		});
	});

	it("removes unleased partial files on open", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-cache-orphan-"));
		roots.push(dataDir);
		const blobId = blobIdFor(Buffer.from("orphan"));
		const hash = blobId.slice("sha256-".length);
		const fanout = path.join(dataDir, "blobs", "domain", "cache", hash.slice(0, 2));
		fs.mkdirSync(fanout, { recursive: true });
		const part = path.join(fanout, `${hash}.part`);
		fs.writeFileSync(part, "partial");
		const cache = new RouterBlobCache({ dataDir, quotaBytesPerDomain: 100, now: () => clock });
		cache.stat("domain", blobId);
		expect(fs.existsSync(part)).toBe(false);
	});
});
