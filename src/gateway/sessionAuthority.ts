import crypto from "node:crypto";
import { Address, composeSessionName, DEFAULT_SESSION, parseTarget } from "../shared/session-id.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { TeamRegistry, WsData } from "./wsTypes.js";

export interface SessionBinding {
	// UNBOUND is an explicit resolver result, never a missing derivation.
	readonly token: string | null;
	readonly __sessionBinding: true;
}

export interface Presented {
	readonly token: string | null;
	readonly __presented: true;
}

export interface SessionAuthorityDeps {
	sessionStore?: SessionStore;
	registry: TeamRegistry;
	// Inject resolution to keep websocket imports out of the runtime cycle.
	resolveLive: (
		registry: TeamRegistry,
		sessionStore: SessionStore | undefined,
		team: string,
	) => { data: WsData } | undefined;
	localDomainId: () => string;
	localGatewayId: string;
}

export interface SessionAuthority {
	// Inert launches do not require tokens they never delivered.
	toClaim(teamKey: string): SessionBinding;

	presentsOwnLaunchToken(teamKey: string, got: Presented): boolean;

	// Socket binding, not record binding, authorizes the answering incarnation.
	toAnswerFor(ws: { data: WsData } | undefined): SessionBinding;

	// Live aliases take precedence over the stored record binding.
	toActFor(teamKey: string): SessionBinding;

	// Unresolved names return null and never imply permission.
	localTeamKey(name: string): string | null;

	// Bound requirements accept only an exact presented token.
	satisfies(need: SessionBinding, got: Presented): boolean;

	mayUseLocalPlane(got: Presented): boolean;

	sameAs(a: SessionBinding, b: SessionBinding): boolean;

	resolveConfirmedManagedSession(req: Request): SessionRecord | null;
}

const UNBOUND: SessionBinding = { token: null, __sessionBinding: true };

export const NOTHING_PRESENTED: Presented = { token: null, __presented: true };

function binding(token: string | null | undefined): SessionBinding {
	return token ? { token, __sessionBinding: true } : UNBOUND;
}

function presented(token: string | null | undefined): Presented {
	return token ? { token, __presented: true } : NOTHING_PRESENTED;
}

export function presentedByRequest(req: Request): Presented {
	// HTTP is the sole reader of the session credential header.
	return presented(req.headers.get("x-session-token"));
}

export function presentedByRegister(reg: { sessionToken?: string }): Presented {
	return presented(reg.sessionToken);
}

export function presentedBySocket(ws: { data: WsData } | undefined): Presented {
	return presented(ws?.data?.boundToken);
}

function secretsEqual(a: string, b: string): boolean {
	// Equal-length secrets use constant-time comparison.
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return crypto.timingSafeEqual(left, right);
}

export function createSessionAuthority(deps: SessionAuthorityDeps): SessionAuthority {
	const { sessionStore, registry, resolveLive, localDomainId, localGatewayId } = deps;

	function toClaim(teamKey: string): SessionBinding {
		const record = sessionStore?.getByTeam(teamKey);
		if (!record || !sessionStore?.isBindingActive(record)) return UNBOUND;
		return binding(record.bindToken);
	}

	function presentsOwnLaunchToken(teamKey: string, got: Presented): boolean {
		if (!got.token) return false;
		const record = sessionStore?.recordByBindToken(got.token);
		if (!record || !sessionStore) return false;
		return sessionStore.teamOf(record) === teamKey;
	}

	function toAnswerFor(ws: { data: WsData } | undefined): SessionBinding {
		return binding(ws?.data?.boundToken);
	}

	function toActFor(teamKey: string): SessionBinding {
		const live = resolveLive(registry, sessionStore, teamKey);
		return live ? toAnswerFor(live) : toClaim(teamKey);
	}

	function localTeamKey(name: string): string | null {
		let target: ReturnType<typeof parseTarget>;
		try {
			target = parseTarget(name, localDomainId(), localGatewayId);
		} catch {
			return null;
		}
		if (target.domain !== localDomainId() || target.gateway !== localGatewayId) return null;
		// Bare spawns resolve to their default session, matching delivery.
		return target instanceof Address
			? composeSessionName(target.spawn, target.session)
			: composeSessionName(target.spawn, DEFAULT_SESSION);
	}

	function satisfies(need: SessionBinding, got: Presented): boolean {
		if (!need.token) return true;
		return !!got.token && secretsEqual(need.token, got.token);
	}

	function sameAs(a: SessionBinding, b: SessionBinding): boolean {
		if (!a.token || !b.token) return a.token === b.token;
		return secretsEqual(a.token, b.token);
	}

	function mayUseLocalPlane(got: Presented): boolean {
		const records = Object.values(sessionStore?.snapshot() ?? {});
		// Only active bindings impose a credential requirement.
		const bound = records.filter((r) => r.bindToken && sessionStore?.isBindingActive(r as SessionRecord));
		if (bound.length === 0) return true;
		return bound.some((r) => satisfies(binding(r.bindToken), got));
	}

	function resolveConfirmedManagedSession(req: Request): SessionRecord | null {
		if (!sessionStore) return null;
		const got = presentedByRequest(req);
		if (!got.token) return null;
		const record = sessionStore.recordByBindToken(got.token);
		if (!record || !sessionStore.isBindingActive(record) || record.confirmedAt === undefined) return null;
		return satisfies(binding(record.bindToken), got) ? record : null;
	}

	return {
		toClaim,
		presentsOwnLaunchToken,
		toAnswerFor,
		toActFor,
		localTeamKey,
		satisfies,
		sameAs,
		mayUseLocalPlane,
		resolveConfirmedManagedSession,
	};
}
