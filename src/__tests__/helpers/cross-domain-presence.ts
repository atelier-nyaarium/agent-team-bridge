import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";

////////////////////////////////
//  Functions & Helpers

export function session(team: string, overrides: Partial<CrossDomainPresenceSession> = {}): CrossDomainPresenceSession {
	return { team, gatewayId: "gw-a", status: "online", kind: "devcontainer", queueDepth: 0, ...overrides };
}
