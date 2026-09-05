import type { FederatedOp } from "../../shared/federation-protocol.js";
import type { Address } from "../../shared/session-id.js";
import type { TeamInfo } from "../../shared/types.js";
import { createPresenceExchange } from "../presenceExchange.js";

export interface FederationPresenceRoutesDeps {
	// teams() delegates to this snapshot. Optional in test harnesses.
	presence?: { snapshot(): TeamInfo[] };
	// The session targets currently shared to a friend Domain (the same slimmed discovery filter.
	sharesFor?: ((domainId: string) => string[]) | null;
	// The disjoint cross-Domain peer set. A cross-Domain send resolves its target's Domain.
	crossDomainPeers?: import("../federation/crossDomainPeers.js").CrossDomainPeers | null;
	// The cross-Domain-presence landing store (gateway/federation/crossDomainPresence.ts) -.
	crossDomainPresenceConsumer?:
		| import("../federation/crossDomainPresenceConsumer.js").CrossDomainPresenceConsumer
		| null;
	tryLocalAddress: (name: string) => Address | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export function createFederationPresenceRoutes({
	presence,
	sharesFor,
	crossDomainPeers,
	crossDomainPresenceConsumer,
	tryLocalAddress,
	relayToGateway,
}: FederationPresenceRoutesDeps) {
	return createPresenceExchange({
		presence,
		sharesFor,
		crossDomainPeers,
		crossDomainPresenceConsumer,
		tryLocalAddress,
		relayToGateway,
	});
}
