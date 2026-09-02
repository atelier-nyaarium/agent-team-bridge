import {
	CrossDomainShareValueSchema,
	CrossDomainUnlinkValueSchema,
	CrossDomainUnshareValueSchema,
	ShareJobLiveParamsSchema,
} from "../../shared/schemasShare.js";
import type { CrossDomainShareTarget } from "../../shared/share-rules.js";
import {
	all,
	dropDomain,
	isSharedTo as ruleIsSharedTo,
	share as ruleShare,
	sharesFor as ruleSharesFor,
	sweep as ruleSweep,
	touch as ruleTouch,
	unshare as ruleUnshare,
	type ShareRecord,
	type ShareState,
	targetKey,
} from "../../shared/share-rules.js";
import type { GatewayRegistration } from "../gatewayBridge.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Attestations expire after a day of silence. */
const ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTESTATIONS_PER_GATEWAY = 500;
const shareId = (sessionTarget: string, target: CrossDomainShareTarget): string =>
	`share:${sessionTarget}|${targetKey(target)}`;
const generationId = (sessionTarget: string, friendDomainId: string): string =>
	`share.generation:${sessionTarget}|${friendDomainId}`;

export interface ShareServiceDeps {
	registry: OwnerStoreRegistry;
	isLinked: (domainId: string, friendDomainId: string) => boolean;
	dropLinkEdge: (domainId: string, friendDomainId: string) => void;
	retireRevokedPeerRows: (domainId: string, sessionTarget: string, friendDomainId: string) => void;
	connectedGateways: (domainId: string) => string[];
	now: () => number;
}

/** `receivedAt` uses the Router clock. `observedAt` records the gateway observation. */
type Attestation = { incarnation: number; jobIds: string[]; observedAt: number; receivedAt: number };

export interface ShareService {
	share(domainId: string, sessionTarget: string, target: CrossDomainShareTarget): { ok: boolean };
	unshare(domainId: string, sessionTarget: string, target: CrossDomainShareTarget): { ok: boolean };
	listShares(domainId: string): { shares: Array<{ sessionTarget: string; target: CrossDomainShareTarget }> };
	isSharedTo(domainId: string, sessionTarget: string, toDomainId: string): boolean;
	sharesFor(domainId: string, toDomainId: string): string[];
	generation(domainId: string, sessionTarget: string, friendDomainId: string): number;
	admitPeerRow(domainId: string, sessionTarget: string, srcDomainId: string): number | null;
	touch(domainId: string, sessionTarget: string): void;
	attest(reg: GatewayRegistration, params: unknown): void;
	sweep(domainId: string, now?: number): number;
	unlink(
		domainId: string,
		friendDomainId: string,
	): { peersRemoved: number; sharesDropped: number; jobsExpired: number };
	register(hooks: OwnerServiceHooks): void;
}

function state(records: ShareRecord[]): ShareState {
	return { shares: records };
}

function assertWrite(result: { kind: string }): void {
	if (result.kind !== "ok") throw new Error(`share state write ${result.kind}`);
}

export function createShareService(deps: ShareServiceDeps): ShareService {
	const attestations = new Map<string, Attestation>();
	const gatewayIncarnations = new Map<string, number>();
	let registeredHooks: OwnerServiceHooks | undefined;
	const records = (domainId: string): ShareRecord[] =>
		deps.registry
			.for(domainId)
			.list("share")
			.filter((record) => record.id.startsWith("share:"))
			.map((record) => ({ ...record.clear }) as unknown as ShareRecord);
	/** Batch the share change with all implied generation bumps. */
	const putState = (
		domainId: string,
		before: ShareRecord[],
		after: ShareRecord[],
		bumps: Array<{ sessionTarget: string; friendDomainId: string }> = [],
	): void => {
		const store = deps.registry.for(domainId);
		const previous = new Map(before.map((record) => [shareId(record.sessionTarget, record.target), record]));
		const next = new Map(after.map((record) => [shareId(record.sessionTarget, record.target), record]));
		const changed = [...next].filter(([id, record]) => JSON.stringify(previous.get(id)) !== JSON.stringify(record));
		const removed = [...previous].filter(([id]) => !next.has(id));
		if (changed.length === 0 && removed.length === 0 && bumps.length === 0) return;
		const result = store.batch((tx) => {
			for (const [id, record] of changed) {
				const current = store.get("share", id);
				tx.put("share", id, current?.version ?? null, { clear: record as unknown as Record<string, unknown> });
			}
			for (const [id] of removed) tx.del("share", id, store.get("share", id)?.version ?? 0);
			for (const { sessionTarget, friendDomainId } of bumps) {
				const id = generationId(sessionTarget, friendDomainId);
				const current = store.get("share", id);
				tx.put("share", id, current?.version ?? null, {
					clear: { generation: Number(current?.clear.generation ?? 0) + 1 },
				});
			}
		});
		assertWrite(result);
	};
	const sharedTo = (records: ShareRecord[], domainId: string, sessionTarget: string, friend: string): boolean =>
		deps.isLinked(domainId, friend) &&
		ruleIsSharedTo(state(records), sessionTarget, friend, (id) => deps.isLinked(domainId, id));
	const attestationsOf = (reg: GatewayRegistration) => `${reg.domainId}|${reg.gatewayId}|`;
	const linkedDomains = (domainId: string): string[] =>
		deps.registry.domains().filter((id) => deps.isLinked(domainId, id));

	return {
		share(domainId, sessionTarget, target) {
			const before = records(domainId);
			putState(domainId, before, ruleShare(state(before), sessionTarget, target, deps.now()).shares);
			return { ok: true };
		},
		// Bump generation only when no remaining record shares the pair.
		unshare(domainId, sessionTarget, target) {
			const before = records(domainId);
			const changed = ruleUnshare(state(before), sessionTarget, target);
			if (!changed.removed) return { ok: false };
			const after = changed.state.shares;
			const friends = target.kind === "domain" ? [target.domainId] : linkedDomains(domainId);
			const revoked = friends.filter(
				(friend) =>
					sharedTo(before, domainId, sessionTarget, friend) &&
					!sharedTo(after, domainId, sessionTarget, friend),
			);
			putState(
				domainId,
				before,
				after,
				revoked.map((friendDomainId) => ({ sessionTarget, friendDomainId })),
			);
			for (const friend of revoked) deps.retireRevokedPeerRows(domainId, sessionTarget, friend);
			return { ok: true };
		},
		listShares(domainId) {
			return {
				shares: all(state(records(domainId))).map(({ sessionTarget, target }) => ({ sessionTarget, target })),
			};
		},
		isSharedTo(domainId, sessionTarget, toDomainId) {
			return (
				deps.isLinked(domainId, toDomainId) &&
				ruleIsSharedTo(state(records(domainId)), sessionTarget, toDomainId, (id) => deps.isLinked(domainId, id))
			);
		},
		sharesFor(domainId, toDomainId) {
			return deps.isLinked(domainId, toDomainId)
				? ruleSharesFor(state(records(domainId)), toDomainId, (id) => deps.isLinked(domainId, id))
				: [];
		},
		generation(domainId, sessionTarget, friendDomainId) {
			return Number(
				deps.registry.for(domainId).get("share", generationId(sessionTarget, friendDomainId))?.clear
					.generation ?? 0,
			);
		},
		admitPeerRow(domainId, sessionTarget, srcDomainId) {
			return deps.isLinked(domainId, srcDomainId) && this.isSharedTo(domainId, sessionTarget, srcDomainId)
				? this.generation(domainId, sessionTarget, srcDomainId)
				: null;
		},
		touch(domainId, sessionTarget) {
			const before = records(domainId);
			putState(domainId, before, ruleTouch(state(before), sessionTarget, deps.now()).shares);
		},
		// Gateways attest only their sessions. Empty attestations clear; the cap is 500.
		attest(reg, params) {
			const attempt = ShareJobLiveParamsSchema.safeParse(params);
			if (!attempt.success) return;
			const parsed = attempt.data;
			if (parsed.incarnation !== reg.incarnation) return;
			if (!parsed.sessionTarget.startsWith(`${reg.domainId}.${reg.gatewayId}.`)) return;
			const prefix = attestationsOf(reg);
			const key = `${prefix}${parsed.sessionTarget}`;
			const gatewayKey = `${reg.domainId}|${reg.gatewayId}`;
			const currentIncarnation = gatewayIncarnations.get(gatewayKey);
			if (currentIncarnation !== undefined && reg.incarnation < currentIncarnation) return;
			if (currentIncarnation === undefined || reg.incarnation > currentIncarnation) {
				gatewayIncarnations.set(gatewayKey, reg.incarnation);
				for (const entry of attestations.keys()) if (entry.startsWith(prefix)) attestations.delete(entry);
			}
			if (parsed.jobIds.length === 0) {
				attestations.delete(key);
				return;
			}
			let held = 0;
			for (const entry of attestations.keys()) if (entry.startsWith(prefix) && entry !== key) held++;
			if (held >= MAX_ATTESTATIONS_PER_GATEWAY) return;
			attestations.set(key, {
				incarnation: reg.incarnation,
				jobIds: parsed.jobIds,
				observedAt: parsed.observedAt,
				receivedAt: deps.now(),
			});
		},
		sweep(domainId, now = deps.now()) {
			const before = records(domainId);
			const live = (sessionTarget: string) =>
				[...attestations.entries()].some(
					([key, value]) =>
						key.startsWith(`${domainId}|`) &&
						key.endsWith(`|${sessionTarget}`) &&
						value.jobIds.length > 0 &&
						now - value.receivedAt <= ATTESTATION_TTL_MS,
				);
			const result = ruleSweep(state(before), now, SHARE_TTL_MS, live);
			putState(domainId, before, result.state.shares);
			return result.removed;
		},
		// Tear down linked friends; unlinked names only drop stale explicit shares.
		unlink(domainId, friendDomainId) {
			const before = records(domainId);
			const linked = deps.isLinked(domainId, friendDomainId);
			const affected = [
				...new Set(
					before
						.filter((record) => sharedTo(before, domainId, record.sessionTarget, friendDomainId))
						.map((record) => record.sessionTarget),
				),
			];
			const dropped = dropDomain(state(before), friendDomainId);
			putState(
				domainId,
				before,
				dropped.state.shares,
				affected.map((sessionTarget) => ({ sessionTarget, friendDomainId })),
			);
			for (const sessionTarget of affected) deps.retireRevokedPeerRows(domainId, sessionTarget, friendDomainId);
			if (!linked) return { peersRemoved: 0, sharesDropped: dropped.removed, jobsExpired: 0 };
			deps.dropLinkEdge(domainId, friendDomainId);
			if (registeredHooks) {
				const localFrame = { type: "unlink", domainId: friendDomainId };
				const friendFrame = { type: "unlink", domainId };
				for (const gatewayId of deps.connectedGateways(domainId))
					registeredHooks.pushFrameTo(domainId, gatewayId, localFrame);
				for (const gatewayId of deps.connectedGateways(friendDomainId))
					registeredHooks.pushFrameTo(friendDomainId, gatewayId, friendFrame);
			}
			return {
				peersRemoved: deps.connectedGateways(friendDomainId).length,
				sharesDropped: dropped.removed,
				jobsExpired: 0,
			};
		},
		register(hooks) {
			registeredHooks = hooks;
			hooks.ownerOp("cross_domain_share", (_op, value) => {
				const parsed = CrossDomainShareValueSchema.parse(value);
				return this.share(_op.domainId, parsed.sessionTarget, parsed.target);
			});
			hooks.ownerOp("cross_domain_unshare", (_op, value) => {
				const parsed = CrossDomainUnshareValueSchema.parse(value);
				return this.unshare(_op.domainId, parsed.sessionTarget, parsed.target);
			});
			hooks.ownerOp("cross_domain_unlink", (_op, value) =>
				this.unlink(_op.domainId, CrossDomainUnlinkValueSchema.parse(value).domainId),
			);
			hooks.ownerOp("cross_domain_list_shares", (op) => this.listShares(op.domainId));
			hooks.gatewayFrame("share_job_live", (reg, params) => this.attest(reg, params));
			// A dropped gateway attests nothing until its next incarnation.
			hooks.onGatewayDropped((reg) => {
				const prefix = attestationsOf(reg);
				for (const entry of attestations.keys()) if (entry.startsWith(prefix)) attestations.delete(entry);
			});
		},
	};
}
