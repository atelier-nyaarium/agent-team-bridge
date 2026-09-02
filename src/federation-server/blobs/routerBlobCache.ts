import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { BlobStore } from "../../shared/blob-store.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import { BLOB_LEASE_MS, type BlobLease, type LeaseRecord, leaseMatches, newLease } from "./blobLease.js";

export interface BlobOrigin {
	domainId: string;
	gatewayId: string;
}

interface CacheEntry {
	origin: BlobOrigin;
	lastReadAt: number;
	size?: number;
	lease?: LeaseRecord;
}

interface CacheIndex {
	entries: Record<string, CacheEntry>;
}

export type CacheBegin = { kind: "lease"; lease: BlobLease } | { kind: "exists" } | { kind: "quota" };
export type CacheCommit =
	| { have: number; complete: boolean }
	| { kind: "lease_expired" | "generation_mismatch" | "gap" | "too_large" };
export type CacheStat =
	| { kind: "complete"; size: number; origin: BlobOrigin; lastReadAt: number }
	| { kind: "miss"; origin?: BlobOrigin };
export type CacheRead = Buffer | { kind: "miss"; origin?: BlobOrigin };

export class RouterBlobCache {
	private readonly domains = new Map<string, { store: BlobStore; index: CacheIndex }>();
	private readonly now: () => number;

	constructor(private readonly options: { dataDir: string; quotaBytesPerDomain: number; now?: () => number }) {
		this.now = options.now ?? (() => Date.now());
	}

	begin(domainId: string, blobId: string, origin: BlobOrigin, size: number): CacheBegin {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (domain.store.stat(blobId).complete) return { kind: "exists" };
		if (size < 0 || size > MAX_BLOB_BYTES || size > this.options.quotaBytesPerDomain) return { kind: "quota" };
		const used = this.used(domain);
		if (used + size > this.options.quotaBytesPerDomain)
			this.evict(domain, used + size - this.options.quotaBytesPerDomain);
		if (this.used(domain) + size > this.options.quotaBytesPerDomain) return { kind: "quota" };
		const generation = (entry?.lease?.generation ?? 0) + 1;
		const lease = newLease(generation, this.now());
		domain.index.entries[blobId] = { origin, lastReadAt: entry?.lastReadAt ?? this.now(), lease };
		this.persist(domainId, domain.index);
		return { kind: "lease", lease };
	}

	renew(domainId: string, blobId: string, leaseId: string): CacheBegin | { kind: "lease_expired" } {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (!entry?.lease || entry.lease.id !== leaseId || entry.lease.expiresAt <= this.now())
			return { kind: "lease_expired" };
		const now = this.now();
		entry.lease = { ...entry.lease, expiresAt: now + BLOB_LEASE_MS, lastRenewedAt: now };
		this.persist(domainId, domain.index);
		return { kind: "lease", lease: entry.lease };
	}

	commitChunk(
		domainId: string,
		blobId: string,
		lease: Pick<BlobLease, "id" | "generation">,
		offset: number,
		bytes: Buffer,
		final: boolean,
	): CacheCommit {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (!entry?.lease) return { kind: "lease_expired" };
		if (entry.lease.generation !== lease.generation) return { kind: "generation_mismatch" };
		if (!leaseMatches(entry.lease, lease, this.now())) return { kind: "lease_expired" };
		const current = domain.store.stat(blobId);
		if (offset + bytes.length > MAX_BLOB_BYTES) return { kind: "too_large" };
		if (offset > current.have) return { kind: "gap" };
		try {
			const result = domain.store.write(blobId, offset, bytes, final);
			if (result.complete) {
				entry.size = result.have;
				delete entry.lease;
			}
			this.persist(domainId, domain.index);
			return result;
		} catch (error) {
			if (error instanceof Error && error.message.includes("gap")) return { kind: "gap" };
			throw error;
		}
	}

	stat(domainId: string, blobId: string): CacheStat {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (domain.store.stat(blobId).complete && entry?.size !== undefined) {
			return { kind: "complete", size: entry.size, origin: entry.origin, lastReadAt: entry.lastReadAt };
		}
		return { kind: "miss", origin: entry?.origin };
	}

	read(domainId: string, blobId: string, offset: number, length: number): CacheRead {
		const domain = this.domain(domainId);
		if (!domain.store.stat(blobId).complete) return { kind: "miss", origin: domain.index.entries[blobId]?.origin };
		const result = domain.store.read(blobId, offset, length).bytes;
		const entry = domain.index.entries[blobId];
		if (entry) {
			entry.lastReadAt = this.now();
			this.persist(domainId, domain.index);
		}
		return result;
	}

	sweep(now = this.now()): void {
		for (const [domainId, domain] of this.domains) {
			this.reconcile(domain, now);
			this.evict(domain, Math.max(0, this.used(domain) - this.options.quotaBytesPerDomain));
			this.persist(domainId, domain.index);
		}
	}

	private reconcile(domain: { store: BlobStore; index: CacheIndex }, now: number): void {
		for (const [blobId, entry] of Object.entries(domain.index.entries)) {
			if (!entry.lease) continue;
			const stat = domain.store.stat(blobId);
			if (stat.complete) {
				entry.size = stat.have;
				delete entry.lease;
			} else if (entry.lease.expiresAt <= now) {
				// Retain the origin for later misses.
				domain.store.remove(blobId);
				delete entry.lease;
			}
		}
	}

	private domain(domainId: string): { store: BlobStore; index: CacheIndex } {
		const existing = this.domains.get(domainId);
		if (existing) return existing;
		const root = path.join(this.options.dataDir, "blobs", domainId, "cache");
		const indexPath = path.join(root, "index.json");
		let index: CacheIndex = { entries: {} };
		try {
			index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as CacheIndex;
			if (!index || typeof index.entries !== "object") throw new Error("invalid index");
		} catch {
			index = { entries: {} };
			this.rebuild(root, index);
		}
		const result = { store: new BlobStore(root), index };
		this.reconcile(result, this.now());
		this.reclaimOrphans(root, index);
		this.persist(domainId, index);
		this.domains.set(domainId, result);
		return result;
	}

	private reclaimOrphans(root: string, index: CacheIndex): void {
		for (const fanout of readDirectories(root)) {
			for (const name of readFiles(path.join(root, fanout))) {
				if (!name.endsWith(".part")) continue;
				const lease = index.entries[`sha256-${name.slice(0, -".part".length)}`]?.lease;
				if (!lease) fs.rmSync(path.join(root, fanout, name), { force: true });
			}
		}
	}

	private rebuild(root: string, index: CacheIndex): void {
		for (const fanout of readDirectories(root)) {
			for (const name of readFiles(path.join(root, fanout))) {
				if (name.endsWith(".part") || name.length !== 64) continue;
				const blobId = `sha256-${name}`;
				index.entries[blobId] = {
					origin: { domainId: "", gatewayId: "" },
					lastReadAt: 0,
					size: fs.statSync(path.join(root, fanout, name)).size,
				};
			}
		}
	}

	private evict(domain: { store: BlobStore; index: CacheIndex }, bytes: number): void {
		if (bytes <= 0) return;
		const candidates = Object.entries(domain.index.entries)
			.filter(([blobId, entry]) => !entry.lease && domain.store.stat(blobId).complete)
			.sort(([, a], [, b]) => a.lastReadAt - b.lastReadAt);
		let remaining = bytes;
		for (const [blobId, entry] of candidates) {
			domain.store.remove(blobId);
			delete domain.index.entries[blobId];
			remaining -= entry.size ?? 0;
			if (remaining <= 0) break;
		}
	}

	private used(domain: { store: BlobStore; index: CacheIndex }): number {
		return Object.keys(domain.index.entries).reduce((sum, blobId) => sum + domain.store.stat(blobId).have, 0);
	}

	private persist(domainId: string, index: CacheIndex): void {
		const file = path.join(this.options.dataDir, "blobs", domainId, "cache", "index.json");
		writeFileAtomic(file, JSON.stringify(index), { fsyncFile: true, fsyncDirectory: true });
	}
}

function readDirectories(root: string): string[] {
	try {
		return fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory());
	} catch {
		return [];
	}
}

function readFiles(directory: string): string[] {
	try {
		return fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
	} catch {
		return [];
	}
}
