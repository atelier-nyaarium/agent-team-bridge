// The cross-Domain presence pipeline, and the teardown an unlink or untrust runs.

import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { CrossDomainUnlinkResult } from "../../shared/console-protocol.js";
import type { FederationSlice, RouterPresenceHandlers } from "../boot.js";
import { createCoalescedPresencePusher } from "../federation/crossDomainPresencePusher.js";
import { createCrossDomainPresenceReconciler } from "../federation/crossDomainPresenceReconciler.js";
import { createCrossDomainPresenceSource } from "../federation/crossDomainPresenceSource.js";
import type { FederationStage } from "./composeFederation.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

export interface RouterPresenceStageDeps {
	ambient: Ambient;
	context: FederationContext;
	stores: Pick<StoresStage, "restored" | "jobs">;
	sessions: Pick<SessionsStage, "planeRegistry" | "presence" | "crossDomainPresenceConsumer">;
	federation: Pick<FederationStage, "markPresenceDirty">;
	routes: () => GatewayRoutes;
}

export interface RouterPresenceBuild extends RouterPresenceHandlers {
	unlinkDomain: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner: (ownerSignPub: string) => CrossDomainUnlinkResult;
}

export interface RouterPresenceStage {
	build: (slice: FederationSlice) => RouterPresenceBuild;
	stop: () => void;
}

export function composeRouterPresence(deps: RouterPresenceStageDeps): RouterPresenceStage {
	const { ambient, context, stores, sessions, routes } = deps;
	let reconcilerTimer: IntervalHandle | null = null;

	function build(slice: FederationSlice): RouterPresenceBuild {
		const presencePusher = createCoalescedPresencePusher(
			(domainId, sessionRows) => routes().pushPresenceToDomain(domainId, sessionRows),
			{ ambient },
		);
		const presenceSource = createCrossDomainPresenceSource({
			planeRegistry: sessions.planeRegistry,
			restoredPlanes: stores.restored.planes,
			presenceForDomain: (domainId) => routes().presenceForDomain(domainId),
			invalidatePresenceCache: () => routes().invalidatePresenceSnapshotCache(),
			linkedAndSharedDomainIds: () =>
				context
					.linkedDomainIds()
					.filter((id) => slice.shareState.sharesFor(id, (peer) => context.isLinkedDomain(peer)).length > 0),
			push: presencePusher.push,
			cancelPush: presencePusher.cancel,
		});
		sessions.presence.onMarkDirty(() => {
			presenceSource.recomputeAll();
			deps.federation.markPresenceDirty();
		});
		presenceSource.recomputeAll();

		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => context.linkedDomainIds(),
			pull: (domainId) => routes().pullPresenceFromDomain(domainId),
			land: (domainId, sessionRows) => sessions.crossDomainPresenceConsumer.land(domainId, sessionRows),
		});
		reconcilerTimer = ambient.setInterval(() => reconciler.tick(), 10_000);

		const forgetDomain = (domainId: string): void => {
			presenceSource.teardown(domainId);
			sessions.crossDomainPresenceConsumer.teardown(domainId);
			reconciler.cancel(domainId);
		};

		const unlinkDomain = (domainId: string): CrossDomainUnlinkResult => {
			const result = {
				peersRemoved: slice.crossDomainPeers.removeByDomain(domainId),
				sharesDropped: slice.shareState.dropDomain(domainId),
				jobsExpired: stores.jobs.expireByDomain(domainId),
			};
			forgetDomain(domainId);
			return result;
		};

		const untrustOwner = (ownerSignPub: string): CrossDomainUnlinkResult => {
			const { removed, domains } = slice.crossDomainPeers.removeByOwner(ownerSignPub);
			let sharesDropped = 0;
			let jobsExpired = 0;
			for (const domainId of domains) {
				sharesDropped += slice.shareState.dropDomain(domainId);
				jobsExpired += stores.jobs.expireByDomain(domainId);
				forgetDomain(domainId);
			}
			return { peersRemoved: removed, sharesDropped, jobsExpired };
		};

		return {
			presenceSource,
			stopPresencePushes: presencePusher.stop,
			unlinkDomain,
			untrustOwner,
		};
	}

	return {
		build,
		stop: () => {
			if (reconcilerTimer) ambient.clearInterval(reconcilerTimer);
		},
	};
}
