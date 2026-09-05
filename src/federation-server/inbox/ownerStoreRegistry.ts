import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../../shared/ambient.js";
import type { DomainQuota } from "../owner/domainQuota.js";
import { type OwnerKey, OwnerStateStore } from "../owner/ownerStateStore.js";

export class UnknownDomain extends Error {
	readonly domainId: string;
	constructor(domainId: string) {
		super("unknown domain");
		this.name = "UnknownDomain";
		this.domainId = domainId;
	}
}

export class OwnerStoreRegistry {
	private readonly stores = new Map<string, OwnerStateStore>();
	private readonly opts: {
		dataDir: string;
		ownerOf: (domainId: string) => string | null;
		quotaFor: (domainId: string) => DomainQuota;
		ambient: Clock;
	};

	constructor(opts: {
		dataDir: string;
		ownerOf: (domainId: string) => string | null;
		quotaFor: (domainId: string) => DomainQuota;
		ambient: Clock;
	}) {
		this.opts = opts;
	}

	ownerKey(domainId: string): OwnerKey {
		const ownerSignPub = this.opts.ownerOf(domainId);
		if (!ownerSignPub) throw new UnknownDomain(domainId);
		return { domainId, ownerSignPub };
	}

	now(): number {
		return this.opts.ambient.now();
	}

	domains(): string[] {
		const ownerDir = path.join(this.opts.dataDir, "owner");
		const persisted = fs.existsSync(ownerDir)
			? fs
					.readdirSync(ownerDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
			: [];
		return [...new Set([...this.stores.keys(), ...persisted])].filter((domainId) => this.opts.ownerOf(domainId));
	}

	health(): { degraded: boolean; quarantined: { domainId: string; missing: { from: number; to: number } }[] } {
		const quarantined: { domainId: string; missing: { from: number; to: number } }[] = [];
		let degraded = false;
		for (const [domainId, store] of this.stores) {
			const health = store.health();
			if (health.degraded) degraded = true;
			if (health.missing) quarantined.push({ domainId, missing: health.missing });
		}
		return { degraded, quarantined };
	}

	for(domainId: string): OwnerStateStore {
		const current = this.stores.get(domainId);
		if (current) return current;
		const key = this.ownerKey(domainId);
		const store = OwnerStateStore.open({
			dataDir: this.opts.dataDir,
			key,
			quota: this.opts.quotaFor(domainId),
			ambient: this.opts.ambient,
		});
		this.stores.set(domainId, store);
		return store;
	}

	close(): void {
		for (const store of this.stores.values()) store.close();
		this.stores.clear();
	}
}
