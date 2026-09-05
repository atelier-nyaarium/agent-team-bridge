import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Ambient } from "../../shared/ambient.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { BlobStore, isBlobId } from "../../shared/blob-store.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import { sealedBlobSize } from "../../shared/sealed-blob.js";
import { BLOB_LEASE_MS, type BlobLease, type LeaseRecord, leaseMatches, newLease } from "./blobLease.js";

export interface BlobOrigin {
	domainId: string;
	gatewayId: string;
}

interface CacheEntry {
	origin: BlobOrigin;
	lastReadAt: number;
	size?: number;
	ciphertextSize?: number;
	ciphertextDigest?: string;
	epoch?: number;
	lease?: LeaseRecord;
}

interface CacheIndex {
	entries: Record<string, CacheEntry>;
}

type CacheRecoveryEntry = Required<Omit<CacheEntry, "lease">>;

const MAX_RETAINED_ORIGINS = 10_000;

export type CacheBegin = { kind: "lease"; lease: BlobLease } | { kind: "exists" } | { kind: "quota" };
export type CacheCommit =
	| { have: number; complete: boolean }
	| { kind: "lease_expired" | "generation_mismatch" | "gap" | "too_large" | "size_mismatch" };
export type CacheStat =
	| {
			kind: "complete";
			size: number;
			ciphertextSize: number;
			epoch: number;
			origin: BlobOrigin;
			lastReadAt: number;
	  }
	| { kind: "miss"; origin?: BlobOrigin };
export type CacheRead = Buffer | { kind: "miss"; origin?: BlobOrigin };

// Sealed cache for key-bearing devices.
export class RouterBlobCache {
	private readonly domains = new Map<string, { store: BlobStore; index: CacheIndex }>();
	private readonly now: () => number;

	constructor(
		private readonly options: {
			dataDir: string;
			quotaBytesPerDomain: number;
			ambient: Pick<Ambient, "now" | "newId">;
		},
	) {
		this.now = () => options.ambient.now();
	}

	begin(
		domainId: string,
		blobId: string,
		origin: BlobOrigin,
		size: number,
		ciphertextSize: number,
		ciphertextDigest: string,
		epoch: number,
	): CacheBegin {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (domain.store.stat(blobId).complete) {
			if (
				entry?.size !== undefined &&
				entry.ciphertextSize !== undefined &&
				entry.ciphertextDigest !== undefined &&
				entry.epoch !== undefined
			)
				return { kind: "exists" };
			domain.store.remove(blobId);
		}
		if (
			size < 0 ||
			size > MAX_BLOB_BYTES ||
			ciphertextSize !== sealedBlobSize(size) ||
			ciphertextSize > this.options.quotaBytesPerDomain
		)
			return { kind: "quota" };
		// Digest changes discard partials.
		if (entry?.ciphertextDigest !== undefined && entry.ciphertextDigest !== ciphertextDigest)
			domain.store.remove(blobId);
		const heldForBlob = Math.max(domain.store.stat(blobId).have, entry?.lease?.expectedSize ?? 0);
		const used = this.used(domain) - heldForBlob;
		if (used + ciphertextSize > this.options.quotaBytesPerDomain)
			this.evict(domainId, domain, used + ciphertextSize - this.options.quotaBytesPerDomain);
		if (this.used(domain) - heldForBlob + ciphertextSize > this.options.quotaBytesPerDomain)
			return { kind: "quota" };
		const generation = (entry?.lease?.generation ?? 0) + 1;
		const lease = newLease(this.options.ambient, generation, this.now(), undefined, ciphertextSize);
		domain.index.entries[blobId] = {
			origin,
			lastReadAt: entry?.lastReadAt ?? this.now(),
			size,
			ciphertextSize,
			ciphertextDigest,
			epoch,
			lease,
		};
		this.persistRecovery(domainId, blobId, domain.index.entries[blobId]);
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
		if (offset + bytes.length > sealedBlobSize(MAX_BLOB_BYTES)) return { kind: "too_large" };
		if (offset > current.have) return { kind: "gap" };
		if (entry.lease.expectedSize !== undefined && offset + bytes.length > entry.lease.expectedSize)
			return { kind: "too_large" };
		if (final && entry.lease.expectedSize !== offset + bytes.length) return { kind: "size_mismatch" };
		try {
			if (!entry.ciphertextDigest) return { kind: "generation_mismatch" };
			const result = domain.store.write(blobId, offset, bytes, final, entry.ciphertextDigest);
			if (result.complete) {
				entry.ciphertextSize = result.have;
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
		if (
			domain.store.stat(blobId).complete &&
			entry?.size !== undefined &&
			entry.ciphertextSize !== undefined &&
			entry.epoch !== undefined
		) {
			return {
				kind: "complete",
				size: entry.size,
				ciphertextSize: entry.ciphertextSize,
				epoch: entry.epoch,
				origin: entry.origin,
				lastReadAt: entry.lastReadAt,
			};
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
			this.persistRecovery(domainId, blobId, entry);
			this.persist(domainId, domain.index);
		}
		return result;
	}

	sweep(now = this.now()): void {
		for (const [domainId, domain] of this.domains) {
			this.reconcile(domainId, domain, now);
			this.evict(domainId, domain, Math.max(0, this.used(domain) - this.options.quotaBytesPerDomain));
			this.trimRetainedOrigins(domain);
			this.persist(domainId, domain.index);
		}
	}

	private reconcile(domainId: string, domain: { store: BlobStore; index: CacheIndex }, now: number): void {
		for (const [blobId, entry] of Object.entries(domain.index.entries)) {
			if (!entry.lease) continue;
			const stat = domain.store.stat(blobId);
			if (stat.complete) {
				entry.ciphertextSize = stat.have;
				delete entry.lease;
			} else if (entry.lease.expiresAt <= now) {
				// Retain origin without bytes.
				domain.store.remove(blobId);
				delete entry.lease;
				delete entry.size;
				delete entry.ciphertextSize;
				delete entry.ciphertextDigest;
				delete entry.epoch;
				this.removeRecovery(domainId, blobId);
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
			this.rebuild(domainId, root, index);
		}
		const result = { store: new BlobStore(root, this.options.ambient), index };
		this.reconcile(domainId, result, this.now());
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

	private rebuild(domainId: string, root: string, index: CacheIndex): void {
		for (const fanout of readDirectories(root)) {
			for (const name of readFiles(path.join(root, fanout))) {
				if (name.endsWith(".part") || name.length !== 64) continue;
				const blobId = `sha256-${name}`;
				const file = path.join(root, fanout, name);
				let recovery: CacheRecoveryEntry | null;
				try {
					recovery = this.readRecovery(domainId, blobId);
				} catch {
					console.warn(`[router-blob-cache] unreadable recovery ${blobId}`);
					fs.rmSync(file, { force: true });
					fs.rmSync(this.recoveryPath(domainId, blobId), { recursive: true, force: true });
					continue;
				}
				if (
					recovery &&
					fs.statSync(file).size === recovery.ciphertextSize &&
					fileDigest(file) === recovery.ciphertextDigest
				) {
					index.entries[blobId] = recovery;
				} else {
					fs.rmSync(file, { force: true });
					this.removeRecovery(domainId, blobId);
				}
			}
		}
	}

	private evict(domainId: string, domain: { store: BlobStore; index: CacheIndex }, bytes: number): void {
		if (bytes <= 0) return;
		const candidates = Object.entries(domain.index.entries)
			.filter(([blobId, entry]) => !entry.lease && domain.store.stat(blobId).complete)
			.sort(([, a], [, b]) => a.lastReadAt - b.lastReadAt);
		let remaining = bytes;
		for (const [blobId, entry] of candidates) {
			const size = entry.ciphertextSize ?? 0;
			domain.store.remove(blobId);
			delete entry.size;
			delete entry.ciphertextSize;
			delete entry.ciphertextDigest;
			delete entry.epoch;
			this.removeRecovery(domainId, blobId);
			remaining -= size;
			if (remaining <= 0) break;
		}
	}

	// Bound retained origins separately.
	private trimRetainedOrigins(domain: { store: BlobStore; index: CacheIndex }): void {
		const retained = Object.entries(domain.index.entries)
			.filter(
				([blobId, entry]) => !entry.lease && entry.size === undefined && !domain.store.stat(blobId).complete,
			)
			.sort(([, a], [, b]) => a.lastReadAt - b.lastReadAt);
		for (const [blobId] of retained.slice(0, Math.max(0, retained.length - MAX_RETAINED_ORIGINS)))
			delete domain.index.entries[blobId];
	}

	private used(domain: { store: BlobStore; index: CacheIndex }): number {
		// Count on-disk bytes.
		return Object.entries(domain.index.entries).reduce(
			(sum, [blobId, entry]) => sum + Math.max(domain.store.stat(blobId).have, entry.lease?.expectedSize ?? 0),
			0,
		);
	}

	private persist(domainId: string, index: CacheIndex): void {
		const file = path.join(this.options.dataDir, "blobs", domainId, "cache", "index.json");
		writeFileAtomic(file, JSON.stringify(index), { fsyncFile: true, fsyncDirectory: true });
	}

	private persistRecovery(domainId: string, blobId: string, entry: CacheEntry): void {
		if (
			entry.size === undefined ||
			entry.ciphertextSize === undefined ||
			entry.ciphertextDigest === undefined ||
			entry.epoch === undefined
		)
			return;
		writeFileAtomic(
			this.recoveryPath(domainId, blobId),
			JSON.stringify({
				origin: entry.origin,
				lastReadAt: entry.lastReadAt,
				size: entry.size,
				ciphertextSize: entry.ciphertextSize,
				ciphertextDigest: entry.ciphertextDigest,
				epoch: entry.epoch,
			}),
			{ fsyncFile: true, fsyncDirectory: true },
		);
	}

	/** Null means invalid metadata. Other failures preserve ciphertext. */
	private readRecovery(domainId: string, blobId: string): CacheRecoveryEntry | null {
		let raw: string;
		try {
			raw = fs.readFileSync(this.recoveryPath(domainId, blobId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			const value = JSON.parse(raw) as Partial<CacheRecoveryEntry>;
			if (
				!value.origin ||
				value.origin.domainId !== domainId ||
				typeof value.origin.gatewayId !== "string" ||
				typeof value.lastReadAt !== "number" ||
				!Number.isFinite(value.lastReadAt) ||
				typeof value.size !== "number" ||
				!Number.isSafeInteger(value.size) ||
				value.size < 0 ||
				value.size > MAX_BLOB_BYTES ||
				typeof value.ciphertextSize !== "number" ||
				!Number.isSafeInteger(value.ciphertextSize) ||
				value.ciphertextSize !== sealedBlobSize(value.size) ||
				!isBlobId(value.ciphertextDigest ?? "") ||
				typeof value.epoch !== "number" ||
				!Number.isSafeInteger(value.epoch) ||
				value.epoch < 1
			)
				return null;
			return value as CacheRecoveryEntry;
		} catch {
			return null;
		}
	}

	private recoveryPath(domainId: string, blobId: string): string {
		const hash = blobId.slice("sha256-".length);
		return path.join(this.options.dataDir, "blob-cache-metadata", domainId, hash.slice(0, 2), `${hash}.json`);
	}

	private removeRecovery(domainId: string, blobId: string): void {
		fs.rmSync(this.recoveryPath(domainId, blobId), { force: true });
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

function fileDigest(file: string): string {
	const hash = crypto.createHash("sha256");
	const descriptor = fs.openSync(file, "r");
	try {
		const bytes = Buffer.alloc(1 << 20);
		for (;;) {
			const count = fs.readSync(descriptor, bytes, 0, bytes.length, null);
			if (count <= 0) break;
			hash.update(bytes.subarray(0, count));
		}
	} finally {
		fs.closeSync(descriptor);
	}
	return `sha256-${hash.digest("hex")}`;
}
