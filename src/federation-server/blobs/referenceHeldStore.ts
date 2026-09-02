import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { BlobStore } from "../../shared/blob-store.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import type { BlobLease } from "./blobLease.js";

export interface BlobReference {
	kind: "entry" | "row" | "scheduled";
	id: string;
}

interface HeldEntry {
	refs: BlobReference[];
	leaseId?: string;
	generation?: number;
}

interface HeldIndex {
	entries: Record<string, HeldEntry>;
}

export type HeldBegin = { kind: "lease"; lease: BlobLease } | { kind: "exists" };
export type HeldCommit = { have: number; complete: boolean } | { kind: "generation_mismatch" | "gap" | "too_large" };

export class ReferenceHeldStore {
	private readonly domains = new Map<string, { store: BlobStore; index: HeldIndex }>();

	constructor(private readonly options: { dataDir: string }) {}

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

	has(domainId: string, blobId: string): boolean {
		return this.refs(domainId, blobId).length > 0;
	}

	begin(domainId: string, blobId: string): HeldBegin {
		const domain = this.domain(domainId);
		if (domain.store.stat(blobId).complete) return { kind: "exists" };
		const generation = domain.index.entries[blobId]?.generation ?? 0;
		const lease = { id: cryptoRandomId(), generation: generation + 1, expiresAt: Number.MAX_SAFE_INTEGER };
		const entry = domain.index.entries[blobId] ?? { refs: [] };
		entry.leaseId = lease.id;
		entry.generation = lease.generation;
		domain.index.entries[blobId] = entry;
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
		if (offset + bytes.length > MAX_BLOB_BYTES) return { kind: "too_large" };
		if (offset > domain.store.stat(blobId).have) return { kind: "gap" };
		const result = domain.store.write(blobId, offset, bytes, final);
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
