import type { DomainSnapshot } from "../../shared/admission.js";
import type {
	ConsoleOp,
	CrossDomainListPeersResult,
	CrossDomainListSharesResult,
	CrossDomainShareTarget,
	CrossDomainUnlinkResult,
} from "../../shared/console-protocol.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import type { TeamInfo } from "../../shared/types.js";
import type { ConsoleTargets } from "./consoleTargets.js";
import type { ConsoleRoutes, CrossDomainConsoleHandlers, CrossDomainShareHandlers } from "./consoleTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface CrossDomainOpsDeps {
	routes: Pick<ConsoleRoutes, "teams">;
	targets: ConsoleTargets;
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	crossDomain?: CrossDomainConsoleHandlers;
	crossDomainShare?: CrossDomainShareHandlers;
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner?: (ownerSignPub: string) => CrossDomainUnlinkResult;
}

////////////////////////////////
//  Functions & Helpers

function sameTarget(a: CrossDomainShareTarget, b: CrossDomainShareTarget): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind !== "domain" || b.kind !== "domain" || a.domainId === b.domainId;
}

export function createCrossDomainHandlers({
	routes,
	targets,
	domain,
	crossDomain,
	crossDomainShare,
	unlinkDomain,
	untrustOwner,
}: CrossDomainOpsDeps) {
	function canonicalShareTarget(sessionTarget: string): string {
		return targets.shareTarget(
			sessionTarget,
			() => new Error(`cannot unshare "${sessionTarget}": only local sessions have shares`),
		).canonical;
	}

	async function assertShareable(sessionTarget: string, target: CrossDomainShareTarget): Promise<string> {
		if (target.kind === "domain" && !crossDomainShare?.isLinkedDomain(target.domainId)) {
			throw new Error(`cannot share to "${target.domainId}": not a linked Domain`);
		}
		const { name, canonical } = targets.shareTarget(
			sessionTarget,
			() => new Error(`cannot share "${sessionTarget}": only local sessions can be shared`),
		);
		const teams = (await routes.teams().json()) as TeamInfo[];
		const team = teams.find((t) => t.team === name);
		if (!team || (team.kind !== "devcontainer" && team.kind !== "loose")) {
			throw new Error(`cannot share "${name}": only devcontainer and loose sessions can be shared`);
		}
		return canonical;
	}

	return {
		listen(_op: Extract<ConsoleOp, { kind: "cross_domain_listen" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listen();
		},

		async request(op: Extract<ConsoleOp, { kind: "cross_domain_request" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			// The Domain root, not the device.
			const root = domain?.()?.snapshot.ownerSignPub;
			if (!root) throw new Error("this Gateway has no Domain owner yet");
			return crossDomain.request({
				listeningToken: op.listeningToken,
				pin: op.pin,
				requesterOwnerSignPub: root,
				requesterDomainId: op.requesterDomainId,
				requesterGatewayId: op.requesterGatewayId,
			});
		},

		confirm(op: Extract<ConsoleOp, { kind: "cross_domain_confirm" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.confirm({
				pin: op.pin,
				mySignedLink: op.mySignedLink,
			});
		},

		listenState(op: Extract<ConsoleOp, { kind: "cross_domain_listen_state" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listenState(op.listeningToken);
		},

		cancel(op: Extract<ConsoleOp, { kind: "cross_domain_cancel" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return { cancelled: crossDomain.cancel({ listeningToken: op.listeningToken, pin: op.pin }) };
		},

		// The mirror lands first, so a Router record never outlives it; a refused record removes a new mirror.
		async share(op: Extract<ConsoleOp, { kind: "cross_domain_share" }>) {
			if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
			const canonicalTarget = await assertShareable(op.sessionTarget, op.target);
			const held = crossDomainShare
				.listShares()
				.some((share) => share.sessionTarget === canonicalTarget && sameTarget(share.target, op.target));
			if (!crossDomainShare.share(canonicalTarget, op.target)) throw new Error(MIGRATING);
			try {
				await crossDomainShare.postRecord("cross_domain_share", canonicalTarget, op.target);
			} catch (error) {
				if (!held) crossDomainShare.unshare(canonicalTarget, op.target);
				throw error;
			}
			return { ok: true as const };
		},

		async unshare(op: Extract<ConsoleOp, { kind: "cross_domain_unshare" }>) {
			if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
			const canonicalTarget = canonicalShareTarget(op.sessionTarget);
			await crossDomainShare.postRecord("cross_domain_unshare", canonicalTarget, op.target);
			const mirror = crossDomainShare.unshare(canonicalTarget, op.target);
			if (mirror === "fenced") throw new Error(MIGRATING);
			if (mirror === "removed") crossDomainShare.expireSessionJobsForTarget(canonicalTarget, op.target);
			return { ok: true as const };
		},

		listShares(_op: Extract<ConsoleOp, { kind: "cross_domain_list_shares" }>): CrossDomainListSharesResult {
			if (!crossDomainShare) throw new Error("cross-Domain sharing is not available on this Gateway");
			return { shares: crossDomainShare.listShares() };
		},

		listPeers(_op: Extract<ConsoleOp, { kind: "cross_domain_list_peers" }>): CrossDomainListPeersResult {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listPeers();
		},

		unlink(op: Extract<ConsoleOp, { kind: "cross_domain_unlink" }>) {
			if (!unlinkDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return unlinkDomain(op.domainId);
		},

		untrust(op: Extract<ConsoleOp, { kind: "cross_domain_untrust" }>) {
			if (!untrustOwner) throw new Error("cross-Domain linking is not available on this Gateway");
			return untrustOwner(op.ownerSignPub);
		},
	};
}
