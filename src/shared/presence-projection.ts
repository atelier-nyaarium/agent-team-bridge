import { type CrossDomainPresenceSession, MAX_CROSSDOMAIN_PRESENCE_SESSIONS } from "./federation-protocol.js";
import type { Address } from "./session-id.js";
import type { TeamInfo } from "./types.js";

/** Projects shareable session fields across the Domain trust boundary. */
export function toCrossDomainPresenceSession(
	t: TeamInfo,
	tryLocalAddress: (name: string) => Address | null,
): CrossDomainPresenceSession | null {
	if (t.kind !== "devcontainer" && t.kind !== "loose") return null;
	if (!tryLocalAddress(t.team)) return null;
	return {
		team: t.team,
		gatewayId: t.gatewayId,
		status: t.status,
		kind: t.kind,
		sessionLabel: t.sessionLabel?.slice(0, 64),
		description: t.description?.slice(0, 120),
		lastActive: t.lastActive,
		queueDepth: t.queue_depth,
		working: t.working,
		needsLogin: t.needsLogin,
	};
}

/** Projects this Gateway's sessions shared with a linked Domain. */
export function presenceForDomain(
	toDomainId: string,
	local: TeamInfo[],
	sharesFor: (domainId: string) => string[],
	tryLocalAddress: (name: string) => Address | null,
): CrossDomainPresenceSession[] {
	const shared = new Set(sharesFor(toDomainId));
	const out: CrossDomainPresenceSession[] = [];
	for (const t of local) {
		if (out.length >= MAX_CROSSDOMAIN_PRESENCE_SESSIONS) break;
		const addr = tryLocalAddress(t.team);
		if (!addr || !shared.has(addr.canonical)) continue;
		const session = toCrossDomainPresenceSession(t, tryLocalAddress);
		if (session) out.push(session);
	}
	return out;
}
