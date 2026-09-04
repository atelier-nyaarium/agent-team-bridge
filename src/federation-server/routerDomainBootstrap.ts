import type { Identity } from "../shared/crypto.js";
import { ReferenceHeldStore } from "./blobs/referenceHeldStore.js";
import { RouterBlobCache } from "./blobs/routerBlobCache.js";
import type { FileSecretStore } from "./fileSecretStore.js";
import { InboxService } from "./inbox/inboxService.js";
import { OwnerStoreRegistry } from "./inbox/ownerStoreRegistry.js";
import { createLeaseService, readRouterMigrationWindow } from "./migration/leaseService.js";
import { DomainQuota } from "./owner/domainQuota.js";
import { loadRouterTls, type RouterTls } from "./routerTls.js";

export class RouterDomainBootstrap {
	public readonly tls: RouterTls;
	public readonly identity: Identity;
	public readonly ownerRegistry: OwnerStoreRegistry;
	public readonly leases: ReturnType<typeof createLeaseService>;
	public readonly inbox: InboxService;
	public readonly blobCache: RouterBlobCache;
	public readonly referenceHeld: ReferenceHeldStore;

	private constructor(fields: {
		tls: RouterTls;
		identity: Identity;
		ownerRegistry: OwnerStoreRegistry;
		leases: ReturnType<typeof createLeaseService>;
		inbox: InboxService;
		blobCache: RouterBlobCache;
		referenceHeld: ReferenceHeldStore;
	}) {
		this.tls = fields.tls;
		this.identity = fields.identity;
		this.ownerRegistry = fields.ownerRegistry;
		this.leases = fields.leases;
		this.inbox = fields.inbox;
		this.blobCache = fields.blobCache;
		this.referenceHeld = fields.referenceHeld;
	}

	public static assemble(params: {
		dataDir: string;
		store: FileSecretStore;
		now: () => number;
		tls?: RouterTls;
		quotaBytes?: number;
		blobCacheBytes?: number;
	}): RouterDomainBootstrap {
		const tls = params.tls ?? loadRouterTls(params.dataDir);
		const identity = params.store.persistedIdentity;
		const quotaBytes = params.quotaBytes ?? 2 * 1024 * 1024 * 1024;
		const ownerRegistry = new OwnerStoreRegistry({
			dataDir: params.dataDir,
			ownerOf: (domainId) => params.store.loadDomain(domainId)?.ownerSignPub ?? null,
			quotaFor: () => new DomainQuota({ dir: params.dataDir, limitBytes: quotaBytes }),
			now: params.now,
		});
		const leases = createLeaseService({
			registry: ownerRegistry,
			migrationWindow: readRouterMigrationWindow,
		});
		const inbox = new InboxService(ownerRegistry, {
			signPub: identity.sign.pub,
			signPriv: identity.sign.priv,
		});
		const blobCache = new RouterBlobCache({
			dataDir: params.dataDir,
			quotaBytesPerDomain: params.blobCacheBytes ?? 1024 * 1024 * 1024,
			now: params.now,
		});
		const referenceHeld = new ReferenceHeldStore({ dataDir: params.dataDir, quotaBytesPerDomain: quotaBytes });
		return new RouterDomainBootstrap({
			tls,
			identity,
			ownerRegistry,
			leases,
			inbox,
			blobCache,
			referenceHeld,
		});
	}
}
