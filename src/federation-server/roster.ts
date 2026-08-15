import { resolveAdmitted, type SignedAdmission, type SignedRevocation } from "../shared/admission.js";
import type { RosterMember, RosterResult } from "../shared/federation-lifecycle.js";

////////////////////////////////
//  Interfaces & Types

export interface RosterDomain {
	domainId: string;
	ownerSignPub: string | null;
	displayName: string | null;
	admissions: SignedAdmission[];
	revocations: SignedRevocation[];
}

////////////////////////////////
//  Functions & Helpers

function admitsConsole(domain: RosterDomain, signerSignPub: string): boolean {
	if (!domain.ownerSignPub) return false;
	const admitted = resolveAdmitted(domain.admissions, domain.revocations, domain.ownerSignPub, signerSignPub);
	return admitted?.kind === "console";
}

export function buildRoster(
	signerSignPub: string,
	domains: RosterDomain[],
	onlineDomainIds: ReadonlySet<string>,
): RosterResult {
	const isMember = domains.some((domain) => admitsConsole(domain, signerSignPub));
	if (!isMember) return { ok: false, error: "not a member of this network" };

	const members: RosterMember[] = domains
		.filter((domain): domain is RosterDomain & { ownerSignPub: string } => domain.ownerSignPub !== null)
		.map((domain) => ({
			ownerSignPub: domain.ownerSignPub,
			displayName: domain.displayName ?? "",
			online: onlineDomainIds.has(domain.domainId),
		}));
	return { ok: true, members };
}
