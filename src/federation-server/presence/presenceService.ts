import type { CrossDomainPresenceSession } from "../../shared/federation-protocol.js";
import { type PresenceRow, presenceIdentityOf } from "../../shared/presence-identity.js";
import { toCrossDomainPresenceSession } from "../../shared/presence-projection.js";
import type { GatewaySpawnPointsSchema } from "../../shared/schemasPresence.js";
import {
	FriendPresenceProjectionSchema,
	OwnerPresenceProjectionSchema,
	PresenceBaselineParamsSchema,
	PresenceDeltaParamsSchema,
	RosterEntrySchema,
} from "../../shared/schemasRouterPresence.js";
import { type Address, isValidSessionName, parseTarget } from "../../shared/session-id.js";
import type { TeamInfo } from "../../shared/types.js";
import type { GatewayRegistration } from "../gatewayBridge.js";
import type { OwnerOpHandler } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

type SpawnPoints = typeof GatewaySpawnPointsSchema._output;
type Baseline = { incarnation: number; seq: 0; rows: TeamInfo[]; spawnPoints: SpawnPoints };
type Delta = { incarnation: number; seq: number; upserts: TeamInfo[]; tombstones: string[] };
type ProjectionDeps = {
	admittedGateways: (domainId: string) => string[];
	linkedDomains: (domainId: string) => string[];
	isShared: (domainId: string, sessionTarget: string, toDomainId: string) => boolean;
	connected: (domainId: string) => string[];
};
type FriendDeps = Pick<ProjectionDeps, "isShared">;

// Gateway IDs exclude ":" and ".".
const rowId = (gatewayId: string, sessionId: string): string => `presence.row:${gatewayId}/${sessionId}`;
const rowPrefix = (gatewayId: string): string => `presence.row:${gatewayId}/`;
const gatewayRecordId = (gatewayId: string): string => `presence.gateway:${gatewayId}`;
const planeRecordId = "presence.plane";
const sortedRows = (rows: PresenceRow[]): PresenceRow[] => [...rows].sort((a, b) => a.team.localeCompare(b.team));
const LIVE_STATUSES = new Set(["online", "verifying"]);

export function createPresenceService(deps: {
	registry: OwnerStoreRegistry;
	now?: () => number;
	projection?: ProjectionDeps;
	friend?: FriendDeps;
	/** Keep live shares alive. */
	touch?: (domainId: string, sessionTarget: string) => void;
	/** Push changed projections. */
	pokeOwner?: (domainId: string, version: number, projection: unknown) => void;
}) {
	const now = deps.now ?? (() => deps.registry.now());
	// Consume after projection assembly.
	let pokePending = false;

	const write = (domainId: string, id: string, clear: Record<string, unknown>): void => {
		const store = deps.registry.for(domainId);
		const current = store.get("presence.row", id);
		const result = store.put("presence.row", id, current?.version ?? null, { clear });
		if (result.kind !== "ok") throw new Error(`presence write ${result.kind}`);
	};

	const rowsFor = (domainId: string): PresenceRow[] =>
		sortedRows(
			deps.registry
				.for(domainId)
				.list("presence.row")
				.filter((record) => record.id.startsWith("presence.row:"))
				.map((record) => record.clear as PresenceRow),
		);

	const gatewayRecords = (domainId: string) =>
		deps.registry
			.for(domainId)
			.list("presence.row")
			.filter((record) => record.id.startsWith("presence.gateway:"));

	// One version per audience.
	const projectionPlane = (domainId: string, key: string, identity: string) => {
		const store = deps.registry.for(domainId);
		const current = store.get("presence.row", planeRecordId);
		const clear = current?.clear as
			| { epoch?: number; versions?: Record<string, number>; identities?: Record<string, string> }
			| undefined;
		const epoch = clear?.epoch ?? Math.floor(now());
		const versions = clear?.versions ?? {};
		const identities = clear?.identities ?? {};
		const version = identities[key] === identity ? (versions[key] ?? 0) : (versions[key] ?? -1) + 1;
		if (!clear || identities[key] !== identity) {
			write(domainId, planeRecordId, {
				epoch,
				versions: { ...versions, [key]: version },
				identities: { ...identities, [key]: identity },
			});
			if (key === "owner") pokePending = true;
		}
		return { epoch, version };
	};

	/** Rows follow registration incarnation. */
	const ownedRow = (reg: GatewayRegistration, row: TeamInfo): PresenceRow => ({
		...row,
		gatewayId: reg.gatewayId,
		domainId: reg.domainId,
		presenceFresh: "fresh",
	});

	const upsertRows = (reg: GatewayRegistration, rows: TeamInfo[]): void => {
		for (const row of rows) {
			write(reg.domainId, rowId(reg.gatewayId, row.team), ownedRow(reg, row));
			if (LIVE_STATUSES.has(row.status))
				deps.touch?.(reg.domainId, `${reg.domainId}.${reg.gatewayId}.${row.team}`);
		}
	};

	const applyBaseline = (reg: GatewayRegistration, params: Baseline) => {
		const parsed = PresenceBaselineParamsSchema.parse(params);
		if (parsed.incarnation !== reg.incarnation) return { resync: true as const };
		const store = deps.registry.for(reg.domainId);
		for (const record of store.list("presence.row")) {
			if (record.id.startsWith(rowPrefix(reg.gatewayId))) store.del("presence.row", record.id, record.version);
		}
		upsertRows(reg, parsed.rows);
		write(reg.domainId, gatewayRecordId(reg.gatewayId), {
			incarnation: parsed.incarnation,
			seq: 0,
			spawnPoints: { ...parsed.spawnPoints, gatewayId: reg.gatewayId, domainId: reg.domainId },
			lastRegisteredAt: now(),
		});
		return { ok: true as const };
	};

	const applyDelta = (reg: GatewayRegistration, params: Delta) => {
		const parsed = PresenceDeltaParamsSchema.parse(params);
		if (parsed.incarnation !== reg.incarnation) return { resync: true as const };
		const store = deps.registry.for(reg.domainId);
		const record = store.get("presence.row", gatewayRecordId(reg.gatewayId));
		// Deltas require a baseline.
		if (
			!record ||
			record.clear.incarnation !== parsed.incarnation ||
			typeof record.clear.seq !== "number" ||
			parsed.seq !== record.clear.seq + 1
		)
			return { resync: true as const };
		for (const sessionId of parsed.tombstones) {
			const current = store.get("presence.row", rowId(reg.gatewayId, sessionId));
			if (current) store.del("presence.row", current.id, current.version);
		}
		upsertRows(reg, parsed.upserts);
		write(reg.domainId, gatewayRecordId(reg.gatewayId), { ...record.clear, seq: parsed.seq });
		return { ok: true as const };
	};

	const markUnreachable = (domainId: string, gatewayId?: string): void => {
		const store = deps.registry.for(domainId);
		for (const record of store.list("presence.row")) {
			if (!record.id.startsWith("presence.row:")) continue;
			if (gatewayId !== undefined && !record.id.startsWith(rowPrefix(gatewayId))) continue;
			if (record.clear.presenceFresh === "unreachable") continue;
			write(domainId, record.id, { ...record.clear, presenceFresh: "unreachable" });
		}
	};

	const onGatewayDropped = (reg: GatewayRegistration): void => markUnreachable(reg.domainId, reg.gatewayId);

	/** Restore persisted projection as unreachable. */
	const rearm = (domainId: string): void => {
		markUnreachable(domainId);
		pushIfChanged(domainId);
	};

	const forgetSession = (reg: GatewayRegistration, sessionId: string): void => {
		const store = deps.registry.for(reg.domainId);
		const current = store.get("presence.row", rowId(reg.gatewayId, sessionId));
		if (current) store.del("presence.row", current.id, current.version);
	};

	const roster = (domainId: string, admitted: string[], connected: string[]) => {
		const live = new Set(connected);
		const entries = admitted.map((gatewayId) => {
			const record = deps.registry.for(domainId).get("presence.row", gatewayRecordId(gatewayId));
			return RosterEntrySchema.parse({
				gatewayId,
				connected: live.has(gatewayId),
				incarnation: Number(record?.clear.incarnation ?? 0),
				lastRegisteredAt: Number(record?.clear.lastRegisteredAt ?? 0),
			});
		});
		return {
			roster: entries,
			coverage: {
				rosterKnown: true,
				asked: admitted.length,
				answered: connected.length,
				unreachable: admitted.filter((id) => !live.has(id)),
			},
		};
	};

	const friendProjection = (domainId: string, toDomainId: string, friendDeps: FriendDeps) => {
		const sessions: CrossDomainPresenceSession[] = [];
		for (const row of rowsFor(domainId)) {
			const sessionTarget = `${domainId}.${row.gatewayId}.${row.team}`;
			if (!friendDeps.isShared(domainId, sessionTarget, toDomainId)) continue;
			const session = toCrossDomainPresenceSession(row, (name) => {
				if (!isValidSessionName(name)) return null;
				return parseTarget(name, domainId, row.gatewayId) as Address;
			});
			if (session) sessions.push(session);
		}
		const bounded = sessions.slice(0, 200);
		const identity = JSON.stringify(bounded.map(({ lastActive: _lastActive, ...rest }) => rest));
		return FriendPresenceProjectionSchema.parse({
			plane: projectionPlane(domainId, `friend:${toDomainId}`, identity),
			sessions: bounded,
		});
	};

	const ownerProjection = (domainId: string, projectionDeps: ProjectionDeps) => {
		const rows = rowsFor(domainId);
		const rosterData = roster(
			domainId,
			projectionDeps.admittedGateways(domainId),
			projectionDeps.connected(domainId),
		);
		const linked = projectionDeps.linkedDomains(domainId).map((linkedDomain) => {
			const projection = friendProjection(linkedDomain, domainId, projectionDeps);
			return {
				domainId: linkedDomain,
				version: projection.plane,
				sessions: projection.sessions,
				lastRefreshedAt: now(),
			};
		});
		// Spawn points require a baseline.
		const spawnPoints = gatewayRecords(domainId)
			.map((record) => record.clear.spawnPoints as SpawnPoints | undefined)
			.filter((points): points is SpawnPoints => points !== undefined);
		const identity = JSON.stringify({
			rows: presenceIdentityOf(rows),
			linked: linked.map(({ domainId, version, sessions }) => ({ domainId, version, sessions })),
			roster: rosterData.roster,
			spawnPoints,
		});
		const plane = projectionPlane(domainId, "owner", identity);
		const projection = OwnerPresenceProjectionSchema.parse({
			plane,
			rows,
			linked,
			...rosterData,
			spawnPoints,
		});
		if (pokePending) {
			pokePending = false;
			deps.pokeOwner?.(domainId, plane.version, projection);
		}
		return projection;
	};

	/** Recompute and push the owner projection. */
	const pushIfChanged = (domainId: string): void => {
		if (!deps.pokeOwner || !deps.projection) return;
		// Projection failure must not fail writes.
		try {
			ownerProjection(domainId, deps.projection);
		} catch {}
	};

	const register = (hooks: OwnerServiceHooks): void => {
		hooks.gatewayFrame("presence_baseline", (reg, params) => {
			const result = applyBaseline(reg, params as Baseline);
			pushIfChanged(reg.domainId);
			return result;
		});
		hooks.gatewayFrame("presence_delta", (reg, params) => {
			const result = applyDelta(reg, params as Delta);
			pushIfChanged(reg.domainId);
			if (result.resync)
				hooks.pushFrameTo(reg.domainId, reg.gatewayId, {
					type: "presence_resync",
					incarnation: reg.incarnation,
				});
			return result;
		});
		hooks.onGatewayRegistered((reg) => {
			const current = deps.registry.for(reg.domainId).get("presence.row", gatewayRecordId(reg.gatewayId));
			const { seq: _seq, ...kept } = (current?.clear ?? {}) as Record<string, unknown>;
			write(reg.domainId, gatewayRecordId(reg.gatewayId), {
				...kept,
				incarnation: reg.incarnation,
				lastRegisteredAt: now(),
			});
			// Registration changes the roster.
			pushIfChanged(reg.domainId);
		});
		hooks.onGatewayDropped((reg) => {
			onGatewayDropped(reg);
			pushIfChanged(reg.domainId);
		});
		hooks.onSessionForgotten((reg, sessionId) => {
			forgetSession(reg, sessionId);
			pushIfChanged(reg.domainId);
		});
		hooks.gatewayFrame("presence_read", (reg) => {
			if (!deps.projection) return { ok: false, error: "projection unavailable" };
			try {
				return ownerProjection(reg.domainId, deps.projection);
			} catch (error) {
				if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
				throw error;
			}
		});
		hooks.ownerOp("presence_read", ((op) => {
			if (!deps.projection) return { outcome: "refused", reason: "projection unavailable" };
			return ownerProjection(op.domainId, deps.projection);
		}) as OwnerOpHandler);
		hooks.ownerOp("presence_read_friend", ((op, value) => {
			const friendDomainId = String(value.toDomainId);
			if (!deps.friend || !deps.projection?.linkedDomains(op.domainId).includes(friendDomainId))
				return { outcome: "refused", reason: "not linked" };
			return friendProjection(friendDomainId, op.domainId, deps.friend);
		}) as OwnerOpHandler);
	};

	return {
		applyBaseline,
		applyDelta,
		onGatewayDropped,
		forgetSession,
		rearm,
		roster,
		ownerProjection,
		friendProjection,
		register,
	};
}
