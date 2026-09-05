import type { Ambient } from "../../shared/ambient.js";
import type { Address } from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";
import { createConsolePushOps } from "../consolePushOps.js";
import type { CallerScope } from "./callerGuards.js";

export interface HumanNotifyRoutesDeps {
	dataDir: string;
	config: GatewayConfig;
	ambient: Pick<Ambient, "now" | "newId" | "setInterval" | "clearInterval">;
	// This Gateway's own Domain owner id (a hash of the owner's signing key), used to key the.
	ownerId?: (() => string | null) | null;
	ownerSignPub?: (() => string | null) | null;
	producerSignPriv?: string;
	routerClient?: import("../router/routerClient.js").RouterClient | null;
	contentKeyStore?: Pick<import("../federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	blobUploader?: ReturnType<typeof import("../router/blobUploader.js").createBlobUploader>;
	localAddress: (name: string) => Address;
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
}

export function createHumanNotifyRoutes({
	dataDir,
	config,
	ambient,
	ownerId,
	ownerSignPub,
	producerSignPriv,
	routerClient,
	contentKeyStore,
	blobUploader,
	localAddress,
	refuseImpersonation,
}: HumanNotifyRoutesDeps) {
	// Constructed per createRoutes call, never hoisted: a rebuild (federation activating mid-session).
	return createConsolePushOps({
		dataDir,
		ownerId,
		routerClient,
		localDomainId: config.localDomainId ?? undefined,
		producerSignPriv,
		ownerSignPub,
		contentKeyStore,
		localGatewayId: config.localGatewayId,
		localAddress,
		ambient,
		// Caught here, or a failed copy surfaces as a bare unhandledRejection instead of the uploader's.
		cacheBlobs: blobUploader
			? (blobIds) => {
					blobUploader
						.uploadAll(blobIds, "cache")
						.catch((error) =>
							console.warn(`[blob-cache] ${error instanceof Error ? error.message : String(error)}`),
						);
				}
			: null,
		refuseImpersonation,
	});
}
