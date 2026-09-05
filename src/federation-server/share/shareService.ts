import {
	CrossDomainShareValueSchema,
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
	type UnlinkedDomainMark,
} from "../../shared/share-rules.js";
import type { WriteOutcome } from "../../shared/write-result.js";
import { foldWriteResult } from "../../shared/write-result.js";
import type { GatewayRegistration } from "../gatewayBridge.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { OwnerStateStore } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Attestations expire after a day of silence. */
const ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTESTATIONS_PER_GATEWAY = 500;
const shareId = (sessionTarget: string, target: CrossDomainShareTarget): string =>
	`share:${sessionTarget}|${targetKey(target)}`;
const generationId = (sessionTarget: string, friendDomainId: string): string =>
	`share.generation:${sessionTarget}|${friendDomainId}`;
const unlinkedId = (friendDomainId: string): string => `share.unlinked:${friendDomainId}`;

export interface ShareServiceDeps {
	registry: OwnerStoreRegistry;
	isLinked: (domainId: string, friendDomainId: string) => boolean;
	linkEdgeId?: (domainId: string, friendDomainId: string) => string | null;
	dropLinkEdge: (domainId: string, friendDomainId: string) => void;
	retireRevokedPeerRows: (domainId: string, sessionTarget: string, friendDomainId: string) => void;
	retireRevokedPeerRowsInBatch?: (
		store: OwnerStateStore,
		tx: Parameters<Parameters<OwnerStateStore["batch"]>[0]>[0],
		domainId: string,
		sessionTarget: string,
		friendDomainId: string,
	) => number;
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
	): { peersRemoved: number; sharesDropped: number; jobsExpired: number; outcome?: WriteOutcome };
	register(hooks: OwnerServiceHooks): void;
}

function state(records: ShareRecord[], unlinkedDomains: UnlinkedDomainMark[] = []): ShareState {
	return { shares: records, ...(unlinkedDomains.length ? { unlinkedDomains } : {}) };
}

/** A gateway names only sessions on itself. */
function ownSession(reg: GatewayRegistration, sessionTarget: string): string {
	const [domainId, gatewayId, ...rest] = sessionTarget.split(".");
	if (domainId !== reg.domainId || gatewayId !== reg.gatewayId || !rest.length) throw new OwnerOpRefused("session");
	return sessionTarget;
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
	const unlinked = (domainId: string): UnlinkedDomainMark[] =>
		deps.registry
			.for(domainId)
			.list("share")
			.filter((record) => record.id.startsWith("share.unlinked:"))
			.map((record) => record.clear as unknown as UnlinkedDomainMark);
	/** Batch the share change with all implied generation bumps. */
	const putState = (
		domainId: string,
		before: ShareRecord[],
		after: ShareRecord[],
		bumps: Array<{ sessionTarget: string; friendDomainId: string }> = [],
		marks: { add?: UnlinkedDomainMark[]; remove?: string[] } = {},
	): ReturnType<typeof foldWriteResult> => {
		const store = deps.registry.for(domainId);
		const previous = new Map(before.map((record) => [shareId(record.sessionTarget, record.target), record]));
		const next = new Map(after.map((record) => [shareId(record.sessionTarget, record.target), record]));
		const changed = [...next].filter(([id, record]) => JSON.stringify(previous.get(id)) !== JSON.stringify(record));
		const removed = [...previous].filter(([id]) => !next.has(id));
		if (
			changed.length === 0 &&
			removed.length === 0 &&
			bumps.length === 0 &&
			!marks.add?.length &&
			!marks.remove?.length
		)
			return { applied: true, outcome: "accepted" };
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
			for (const { domainId: friendDomainId, edgeId } of marks.add ?? []) {
				const id = unlinkedId(friendDomainId);
				if (!store.get("share", id)) tx.put("share", id, null, { clear: { domainId: friendDomainId, edgeId } });
			}
			for (const friendDomainId of marks.remove ?? []) {
				const current = store.get("share", unlinkedId(friendDomainId));
				if (current) tx.del("share", current.id, current.version);
			}
			for (const { sessionTarget, friendDomainId } of bumps)
				deps.retireRevokedPeerRowsInBatch?.(store, tx, domainId, sessionTarget, friendDomainId);
		});
		return foldWriteResult(result);
	};
	const sharedTo = (records: ShareRecord[], domainId: string, sessionTarget: string, friend: string): boolean =>
		deps.isLinked(domainId, friend) &&
		ruleIsSharedTo(
			state(records, unlinked(domainId)),
			sessionTarget,
			friend,
			(id) => deps.isLinked(domainId, id),
			(id) => deps.linkEdgeId?.(domainId, id) ?? null,
		);
	const attestationsOf = (reg: GatewayRegistration) => `${reg.domainId}|${reg.gatewayId}|`;
	const linkedDomains = (domainId: string): string[] =>
		deps.registry.domains().filter((id) => deps.isLinked(domainId, id));

	return {
		share(domainId, sessionTarget, target) {
			const before = records(domainId);
			const written = putState(
				domainId,
				before,
				ruleShare(state(before, unlinked(domainId)), sessionTarget, target, deps.now()).shares,
				[],
				target.kind === "domain" ? { remove: [target.domainId] } : {},
			);
			return written.applied ? { ok: true } : { ok: false, outcome: written.outcome };
		},
		// Bump generation only when no remaining record shares the pair.
		unshare(domainId, sessionTarget, target) {
			const before = records(domainId);
			const changed = ruleUnshare(state(before, unlinked(domainId)), sessionTarget, target);
			if (!changed.removed) return { ok: false };
			const after = changed.state.shares;
			const friends = target.kind === "domain" ? [target.domainId] : linkedDomains(domainId);
			const revoked = friends.filter(
				(friend) =>
					sharedTo(before, domainId, sessionTarget, friend) &&
					!sharedTo(after, domainId, sessionTarget, friend),
			);
			const written = putState(
				domainId,
				before,
				after,
				revoked.map((friendDomainId) => ({ sessionTarget, friendDomainId })),
			);
			if (written.applied && !deps.retireRevokedPeerRowsInBatch)
				for (const friend of revoked) deps.retireRevokedPeerRows(domainId, sessionTarget, friend);
			return written.applied ? { ok: true } : { ok: false, outcome: written.outcome };
		},
		listShares(domainId) {
			return {
				shares: all(state(records(domainId))).map(({ sessionTarget, target }) => ({ sessionTarget, target })),
			};
		},
		isSharedTo(domainId, sessionTarget, toDomainId) {
			return (
				deps.isLinked(domainId, toDomainId) &&
				ruleIsSharedTo(
					state(records(domainId), unlinked(domainId)),
					sessionTarget,
					toDomainId,
					(id) => deps.isLinked(domainId, id),
					(id) => deps.linkEdgeId?.(domainId, id) ?? null,
				)
			);
		},
		sharesFor(domainId, toDomainId) {
			return deps.isLinked(domainId, toDomainId)
				? ruleSharesFor(
						state(records(domainId), unlinked(domainId)),
						toDomainId,
						(id) => deps.isLinked(domainId, id),
						(id) => deps.linkEdgeId?.(domainId, id) ?? null,
					)
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
			const result = ruleSweep(state(before, unlinked(domainId)), now, SHARE_TTL_MS, live);
			const revoked = [
				...new Set(
					before.flatMap((record) =>
						linkedDomains(domainId)
							.filter(
								(friend) =>
									sharedTo(before, domainId, record.sessionTarget, friend) &&
									!sharedTo(result.state.shares, domainId, record.sessionTarget, friend),
							)
							.map((friendDomainId) => `${record.sessionTarget}|${friendDomainId}`),
					),
				),
			].map((value) => {
				const [sessionTarget, friendDomainId] = value.split("|");
				return { sessionTarget, friendDomainId };
			});
			const written = putState(domainId, before, result.state.shares, revoked);
			if (written.applied && !deps.retireRevokedPeerRowsInBatch)
				for (const { sessionTarget, friendDomainId } of revoked)
					deps.retireRevokedPeerRows(domainId, sessionTarget, friendDomainId);
			return result.removed;
		},
		// Tear down linked friends; unlinked names only drop stale explicit shares.
		unlink(domainId, friendDomainId) {
			const before = records(domainId);
			const isCurrentlyLinked = deps.isLinked(domainId, friendDomainId);
			const affected = [
				...new Set(
					before
						.filter((record) => sharedTo(before, domainId, record.sessionTarget, friendDomainId))
						.map((record) => record.sessionTarget),
				),
			];
			const dropped = dropDomain(state(before, unlinked(domainId)), friendDomainId);
			const written = putState(
				domainId,
				before,
				dropped.state.shares,
				affected.map((sessionTarget) => ({ sessionTarget, friendDomainId })),
				isCurrentlyLinked
					? { add: [{ domainId: friendDomainId, edgeId: deps.linkEdgeId?.(domainId, friendDomainId) ?? "" }] }
					: {},
			);
			if (!written.applied)
				return { peersRemoved: 0, sharesDropped: 0, jobsExpired: 0, outcome: written.outcome };
			if (!deps.retireRevokedPeerRowsInBatch)
				for (const sessionTarget of affected)
					deps.retireRevokedPeerRows(domainId, sessionTarget, friendDomainId);
			if (!isCurrentlyLinked) return { peersRemoved: 0, sharesDropped: dropped.removed, jobsExpired: 0 };
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
			hooks.onSweep("share sweep", (domainId, now) => this.sweep(domainId, now));
			hooks.ownerOp("cross_domain_share", (op, value) =>
				this.share(op.domainId, value.sessionTarget, value.target),
			);
			hooks.ownerOp("cross_domain_unshare", (op, value) =>
				this.unshare(op.domainId, value.sessionTarget, value.target),
			);
			hooks.ownerOp("cross_domain_unlink", (op, value) => this.unlink(op.domainId, value.domainId));
			hooks.ownerOp("cross_domain_list_shares", (op) => this.listShares(op.domainId));
			// An attestation lives in memory, so nothing waits for the window.
			hooks.gatewayFrame("share_job_live", "read", (reg, params) => this.attest(reg, params));
			hooks.gatewayFrame("cross_domain_share", "value", (reg, params) => {
				const value = CrossDomainShareValueSchema.parse(params);
				return this.share(reg.domainId, ownSession(reg, value.sessionTarget), value.target);
			});
			hooks.gatewayFrame("cross_domain_unshare", "value", (reg, params) => {
				const value = CrossDomainUnshareValueSchema.parse(params);
				return this.unshare(reg.domainId, ownSession(reg, value.sessionTarget), value.target);
			});
			// A dropped gateway attests nothing until its next incarnation.
			hooks.onGatewayDropped((reg) => {
				const prefix = attestationsOf(reg);
				for (const entry of attestations.keys()) if (entry.startsWith(prefix)) attestations.delete(entry);
			});
		},
	};
}
