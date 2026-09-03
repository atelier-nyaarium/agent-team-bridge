import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { BlobStore } from "../../shared/blob-store.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import { sealedBlobSize } from "../../shared/sealed-blob.js";
import type { BlobLease } from "./blobLease.js";

export interface BlobReference {
	kind: "entry" | "row" | "scheduled";
	id: string;
}

interface HeldEntry {
	refs: BlobReference[];
	size?: number;
	ciphertextSize?: number;
	ciphertextDigest?: string;
	epoch?: number;
	leaseId?: string;
	generation?: number;
}

interface HeldIndex {
	entries: Record<string, HeldEntry>;
}

export type HeldBegin = { kind: "lease"; lease: BlobLease } | { kind: "exists" } | { kind: "quota" };
export type HeldCommit =
	| { have: number; complete: boolean }
	| { kind: "generation_mismatch" | "gap" | "too_large" | "size_mismatch" };

export class ReferenceHeldStore {
	private readonly domains = new Map<string, { store: BlobStore; index: HeldIndex }>();

	constructor(private readonly options: { dataDir: string; quotaBytesPerDomain?: number }) {}

	// Idempotent by reference.
	hold(domainId: string, blobId: string, ref: BlobReference): void {
		const domain = this.domain(domainId);
		let entry = domain.index.entries[blobId];
		if (!entry) {
			entry = { refs: [] };
			domain.index.entries[blobId] = entry;
		}
		if (!entry.refs.some((candidate) => candidate.kind === ref.kind && candidate.id === ref.id))
			entry.refs.push(ref);
		this.persist(domainId, domain.index);
	}

	release(domainId: string, blobId: string, ref: BlobReference): void {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (!entry) return;
		entry.refs = entry.refs.filter((candidate) => candidate.kind !== ref.kind || candidate.id !== ref.id);
		if (entry.refs.length === 0) {
			domain.store.remove(blobId);
			delete domain.index.entries[blobId];
		}
		this.persist(domainId, domain.index);
	}

	refs(domainId: string, blobId: string): BlobReference[] {
		return [...(this.domain(domainId).index.entries[blobId]?.refs ?? [])];
	}

	/** Complete blobs only. */
	has(domainId: string, blobId: string): boolean {
		if (this.refs(domainId, blobId).length === 0) return false;
		return this.domain(domainId).store.stat(blobId).complete;
	}

	begin(
		domainId: string,
		blobId: string,
		size: number,
		ciphertextSize: number,
		ciphertextDigest: string,
		epoch: number,
	): HeldBegin {
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
		if (size < 0 || size > MAX_BLOB_BYTES || ciphertextSize !== sealedBlobSize(size)) {
			throw new Error("invalid sealed blob size");
		}
		const quota = this.options.quotaBytesPerDomain ?? Number.MAX_SAFE_INTEGER;
		const reserved = Object.entries(domain.index.entries).reduce((sum, [id, value]) => {
			if (id === blobId) return sum;
			const have = domain.store.stat(id).have;
			return sum + Math.max(have, value.leaseId ? (value.ciphertextSize ?? 0) : 0);
		}, 0);
		if (reserved + ciphertextSize > quota) return { kind: "quota" };
		const generation = domain.index.entries[blobId]?.generation ?? 0;
		const lease = { id: cryptoRandomId(), generation: generation + 1, expiresAt: Number.MAX_SAFE_INTEGER };
		const next = domain.index.entries[blobId] ?? { refs: [] };
		next.leaseId = lease.id;
		next.generation = lease.generation;
		next.size = size;
		next.ciphertextSize = ciphertextSize;
		next.ciphertextDigest = ciphertextDigest;
		next.epoch = epoch;
		domain.index.entries[blobId] = next;
		this.persist(domainId, domain.index);
		return { kind: "lease", lease };
	}

	commitChunk(
		domainId: string,
		blobId: string,
		lease: Pick<BlobLease, "id" | "generation">,
		offset: number,
		bytes: Buffer,
		final: boolean,
	): HeldCommit {
		const domain = this.domain(domainId);
		const entry = domain.index.entries[blobId];
		if (!entry || entry.leaseId !== lease.id || entry.generation !== lease.generation)
			return { kind: "generation_mismatch" };
		if (offset + bytes.length > sealedBlobSize(MAX_BLOB_BYTES)) return { kind: "too_large" };
		if (offset > domain.store.stat(blobId).have) return { kind: "gap" };
		if (entry.ciphertextSize !== undefined && offset + bytes.length > entry.ciphertextSize)
			return { kind: "too_large" };
		if (final && entry.ciphertextSize !== offset + bytes.length) return { kind: "size_mismatch" };
		if (!entry.ciphertextDigest) return { kind: "generation_mismatch" };
		const result = domain.store.write(blobId, offset, bytes, final, entry.ciphertextDigest);
		if (result.complete) {
			delete entry.leaseId;
			delete entry.generation;
		}
		this.persist(domainId, domain.index);
		return result;
	}

	seal(domainId: string, blobId: string, lease: Pick<BlobLease, "id" | "generation">): HeldCommit {
		const domain = this.domain(domainId);
		const have = domain.store.stat(blobId).have;
		return this.commitChunk(domainId, blobId, lease, have, Buffer.alloc(0), true);
	}

	reconcile(domainId: string, alive: (ref: BlobReference) => boolean): void {
		const domain = this.domain(domainId);
		for (const [blobId, entry] of Object.entries(domain.index.entries)) {
			entry.refs = entry.refs.filter(alive);
			if (entry.refs.length === 0) {
				domain.store.remove(blobId);
				delete domain.index.entries[blobId];
			}
		}
		this.persist(domainId, domain.index);
	}

	private domain(domainId: string): { store: BlobStore; index: HeldIndex } {
		const existing = this.domains.get(domainId);
		if (existing) return existing;
		const root = path.join(this.options.dataDir, "blobs", domainId, "held");
		const file = path.join(root, "index.json");
		let index: HeldIndex = { entries: {} };
		try {
			index = JSON.parse(fs.readFileSync(file, "utf8")) as HeldIndex;
			if (!index || typeof index.entries !== "object") throw new Error("invalid index");
		} catch {
			index = { entries: {} };
			this.persist(domainId, index);
		}
		const result = { store: new BlobStore(root), index };
		this.domains.set(domainId, result);
		return result;
	}

	private persist(domainId: string, index: HeldIndex): void {
		writeFileAtomic(
			path.join(this.options.dataDir, "blobs", domainId, "held", "index.json"),
			JSON.stringify(index),
			{
				fsyncFile: true,
				fsyncDirectory: true,
			},
		);
	}
}

function cryptoRandomId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
