import { PresenceFacade } from "../../gateway/presence.js";
import type { RoutesDeps } from "../../gateway/routes.js";
import { createSessionAuthority } from "../../gateway/sessionAuthority.js";
import { resolveLiveIncarnation } from "../../gateway/websocket.js";
import { PendingJobStore } from "../../shared/pending-job-store.js";
import { PlaneRegistry } from "../../shared/plane-registry.js";
import { SessionStore } from "../../shared/session-store.js";
import type { ResponsePayload } from "../../shared/types.js";

////////////////////////////////
//  Functions & Helpers

export const TEST_REQ = new Request("http://gateway/test");

/** Wrap a fake WebSocket into the nested registry structure: team -> subId -> ws */
export function makeRegistry(entries: Record<string, unknown>): RoutesDeps["registry"] {
	const registry = new Map() as RoutesDeps["registry"];
	for (const [team, ws] of Object.entries(entries)) {
		const subs = new Map();
		subs.set("sub-1", ws);
		registry.set(team, subs);
	}
	return registry;
}

/** Builds a real PresenceFacade wired to the same registry/offlineCatalog/sessionStore a test's
 * RoutesDeps uses, so /teams exercises the actual production computation instead of a second,
 * parallel one. Call `.wakeStart(team)` on the returned facade to simulate a wake in flight - the
 * facade owns that state itself now (no more external isWakeInFlight predicate feeding it). */
export function makePresence(opts: {
	registry: RoutesDeps["registry"];
	offlineCatalog: Map<string, string>;
	sessionStore?: SessionStore;
	localDomainId?: () => string | null;
	displayName?: (() => string | null | undefined) | null;
	isAdminDomain?: (() => boolean | null) | null;
}): PresenceFacade {
	const facade = new PresenceFacade({
		sessionStore: opts.sessionStore ?? new SessionStore(),
		registry: opts.registry,
		offlineCatalog: opts.offlineCatalog,
		localGatewayId: "test-host",
		localDomainId: opts.localDomainId ?? (() => "alice"),
		displayName: opts.displayName ?? (() => null),
		isAdminDomain: opts.isAdminDomain ?? (() => null),
	});
	facade.attach(new PlaneRegistry());
	facade.registerPlane();
	return facade;
}

/** RoutesDeps plus the values makeCtx needs to BUILD a presence facade. These are presence's
 * construction inputs, not the route table's, so they are not part of RoutesDeps. */
export type CtxOverrides = Partial<RoutesDeps> & {
	offlineCatalog?: Map<string, string>;
	displayName?: (() => string | null | undefined) | null;
	isAdminDomain?: (() => boolean | null) | null;
};

export function makeCtx(overrides: CtxOverrides = {}): RoutesDeps {
	const registry = overrides.registry || (new Map() as RoutesDeps["registry"]);
	const conversationRegistry = overrides.conversationRegistry || (new Map() as RoutesDeps["conversationRegistry"]);
	const store = overrides.store || new PendingJobStore<ResponsePayload>();
	const offlineCatalog = overrides.offlineCatalog || new Map<string, string>();
	const config = { localGatewayId: "test-host", localDomainId: "alice" };
	return {
		registry,
		conversationRegistry,
		store,
		config,
		auth: createSessionAuthority({
			sessionStore: overrides.sessionStore,
			registry,
			resolveLive: resolveLiveIncarnation,
			localDomainId: () => config.localDomainId,
			localGatewayId: config.localGatewayId,
		}),
		tryWakeTeam: overrides.tryWakeTeam || (() => Promise.resolve({ ok: false })),
		sessionStore: overrides.sessionStore,
		presence:
			overrides.presence ||
			makePresence({
				registry,
				offlineCatalog,
				sessionStore: overrides.sessionStore,
				// Reads `config.localDomainId` LAZILY (at snapshot time, not construction time) so a
				// test that mutates `ctx.config.localDomainId` after calling makeCtx (a pre-existing
				// pattern in this file) is still honored.
				localDomainId: () => config.localDomainId,
				displayName: overrides.displayName,
				isAdminDomain: overrides.isAdminDomain,
			}),
		touchShares: overrides.touchShares,
		sharesFor: overrides.sharesFor,
		crossDomainPresenceConsumer: overrides.crossDomainPresenceConsumer,
		ownerId: overrides.ownerId,
		boardClient: overrides.boardClient,
		resolveHandshake: overrides.resolveHandshake,
		findPendingHandshake: overrides.findPendingHandshake,
		repushHandshake: overrides.repushHandshake,
		// Last, so a dep this builder does not yet name still reaches createRoutes. Forgetting to
		// forward one cost a round of mystery 503s; the spread makes that impossible rather than
		// remembered. The named fields above stay, because several are COMPUTED from other overrides.
		...overrides,
	};
}
