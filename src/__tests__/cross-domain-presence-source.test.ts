import { describe, expect, it } from "vitest";
import {
	createCrossDomainPresenceSource,
	crossDomainPresenceSourcePlaneName,
} from "../gateway/federation/crossDomainPresence.js";
import type { CrossDomainPresenceSession } from "../shared/federation-protocol.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { session } from "./helpers/cross-domain-presence.js";

const noopCancel = () => {};
const noopInvalidate = () => {};

describe("createCrossDomainPresenceSource (outbound side)", () => {
	it("a brand-new Domain's first recompute registers its plane and pushes unconditionally (cold start)", () => {
		const registry = new PlaneRegistry();
		const pushed: Array<{ domainId: string; sessions: CrossDomainPresenceSession[] }> = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => [session("story")],
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (domainId, sessions) => pushed.push({ domainId, sessions }),
			cancelPush: noopCancel,
		});

		source.recomputeDomain("bob-domain");
		expect(registry.hasPlane(crossDomainPresenceSourcePlaneName("bob-domain"))).toBe(true);
		// Cold start bypasses the hash-bump gate entirely: recompute() alone could never see a
		// brand-new plane's very first content as "changed" against its own seeded baseline.
		expect(pushed).toEqual([{ domainId: "bob-domain", sessions: [session("story")] }]);
	});

	it("recompute on an already-registered Domain with UNCHANGED content does not push again", () => {
		const registry = new PlaneRegistry();
		const current = [session("story")];
		const pushed: unknown[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => current,
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (domainId, sessions) => pushed.push({ domainId, sessions }),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain"); // cold-start push
		expect(pushed).toHaveLength(1);

		source.recomputeDomain("bob-domain"); // nothing changed
		expect(pushed).toHaveLength(1);
	});

	it("recompute on an already-registered Domain with CHANGED content pushes again via onBump", () => {
		const registry = new PlaneRegistry();
		let current = [session("story")];
		const pushed: Array<CrossDomainPresenceSession[]> = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => current,
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (_domainId, sessions) => pushed.push(sessions),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain");
		current = [session("story"), session("app")];
		source.recomputeDomain("bob-domain");
		// Pushed content is sorted by (team, gatewayId) - "app" sorts before "story".
		expect(pushed).toEqual([[session("story")], [session("app"), session("story")]]);
	});

	it("a Domain registered WITH restored persisted state does NOT get the unconditional cold-start push", () => {
		const priorRegistry = new PlaneRegistry();
		priorRegistry.registerPlane({
			name: crossDomainPresenceSourcePlaneName("bob-domain"),
			snapshot: () => [session("story")],
			identityOf: (s) => JSON.stringify(s),
		});
		const restoredPlanes = priorRegistry.persistedState(true);

		const registry = new PlaneRegistry();
		const pushed: unknown[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes,
			presenceForDomain: () => [session("story")], // unchanged from what was persisted
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (_domainId, sessions) => pushed.push(sessions),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain");
		// No push: this is a restored plane, not a brand-new one - reconcileOnBoot/the tripwire own
		// deciding whether anything actually drifted, not an unconditional bypass on every boot.
		expect(pushed).toEqual([]);
	});

	it("a Domain registered from an UNCLEAN restore (cleanShutdown:false) DOES get the unconditional push", () => {
		const priorRegistry = new PlaneRegistry();
		priorRegistry.registerPlane({
			name: crossDomainPresenceSourcePlaneName("bob-domain"),
			snapshot: () => [session("story")],
			identityOf: (s) => JSON.stringify(s),
		});
		// A regular 3s persist tick, not a graceful SIGTERM/SIGINT - the common non-graceful-restart
		// case (crash, OOM, docker kill), where the persisted comparison point cannot be trusted.
		const restoredPlanes = priorRegistry.persistedState(false);
		expect(restoredPlanes[crossDomainPresenceSourcePlaneName("bob-domain")]?.cleanShutdown).toBe(false);

		const registry = new PlaneRegistry();
		const pushed: unknown[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes,
			presenceForDomain: () => [session("story")], // even unchanged content must still push
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (_domainId, sessions) => pushed.push(sessions),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain");
		// Plane's own constructor reseeds the baseline from the CURRENT snapshot for a non-clean
		// restore (same as a brand-new plane), so nothing else could ever detect a difference from
		// it later - this unconditional push is the only way the peer's possibly-stale cached view
		// ever gets corrected after a non-graceful restart.
		expect(pushed).toEqual([[session("story")]]);
	});

	it("recomputeDomain on a Domain no longer linked-and-shared tears itself down instead of registering a zombie plane", () => {
		const registry = new PlaneRegistry();
		const pushed: unknown[] = [];
		let linked: string[] = ["bob-domain"];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => [session("story")],
			linkedAndSharedDomainIds: () => linked,
			invalidatePresenceCache: noopInvalidate,
			push: (_domainId, sessions) => pushed.push(sessions),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain"); // cold-start push while genuinely linked-and-shared
		expect(registry.hasPlane(crossDomainPresenceSourcePlaneName("bob-domain"))).toBe(true);

		// Simulates dropDomain's onChange firing recomputeDomain for a Domain the SAME unlink call
		// already removed from the peer set - linkedAndSharedDomainIds no longer includes it.
		linked = [];
		source.recomputeDomain("bob-domain");
		expect(registry.hasPlane(crossDomainPresenceSourcePlaneName("bob-domain"))).toBe(false);
		expect(pushed).toHaveLength(1); // no second (doomed, to-nobody) push fired for the teardown
	});

	it("recomputeAll walks every id linkedAndSharedDomainIds reports, each independently", () => {
		const registry = new PlaneRegistry();
		const pushedDomains: string[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: (domainId) => [session(domainId)],
			linkedAndSharedDomainIds: () => ["bob-domain", "carol-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: (domainId) => pushedDomains.push(domainId),
			cancelPush: noopCancel,
		});
		source.recomputeAll();
		expect(pushedDomains.sort()).toEqual(["bob-domain", "carol-domain"]);
	});

	it("recomputeAll calls linkedAndSharedDomainIds ONCE per pass, not once per Domain (stays linear, not quadratic)", () => {
		const registry = new PlaneRegistry();
		let calls = 0;
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: (domainId) => [session(domainId)],
			linkedAndSharedDomainIds: () => {
				calls += 1;
				return ["bob-domain", "carol-domain", "dave-domain"];
			},
			invalidatePresenceCache: noopInvalidate,
			push: () => {},
			cancelPush: noopCancel,
		});
		source.recomputeAll();
		expect(calls).toBe(1); // not 4 (once upfront + once per each of the 3 domains)
	});

	it("recomputeAll invalidates the presence cache exactly ONCE per pass, not once per Domain", () => {
		const registry = new PlaneRegistry();
		let invalidateCalls = 0;
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: (domainId) => [session(domainId)],
			linkedAndSharedDomainIds: () => ["bob-domain", "carol-domain", "dave-domain"],
			invalidatePresenceCache: () => {
				invalidateCalls += 1;
			},
			push: () => {},
			cancelPush: noopCancel,
		});
		source.recomputeAll();
		expect(invalidateCalls).toBe(1);
	});

	it("recomputeDomain invalidates the presence cache on EVERY call, so two same-tick recomputes each see fresh state", () => {
		const registry = new PlaneRegistry();
		let invalidateCalls = 0;
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => [session("story")],
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: () => {
				invalidateCalls += 1;
			},
			push: () => {},
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain");
		source.recomputeDomain("bob-domain");
		expect(invalidateCalls).toBe(2);
	});

	it("teardown drops tracking so a later recomputeDomain treats the Domain as brand new again", () => {
		const registry = new PlaneRegistry();
		const pushed: unknown[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => [session("story")],
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: () => pushed.push(1),
			cancelPush: noopCancel,
		});
		source.recomputeDomain("bob-domain");
		source.teardown("bob-domain");
		expect(registry.hasPlane(crossDomainPresenceSourcePlaneName("bob-domain"))).toBe(false);

		source.recomputeDomain("bob-domain"); // re-linked later
		expect(pushed).toHaveLength(2); // the original cold start, plus this fresh one
	});

	it("teardown cancels any in-flight/pending push for that Domain, so a fast relink's cold-start push is never silently coalesced away", () => {
		const registry = new PlaneRegistry();
		const cancelled: string[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => [session("story")],
			linkedAndSharedDomainIds: () => ["bob-domain"],
			invalidatePresenceCache: noopInvalidate,
			push: () => {},
			cancelPush: (domainId) => cancelled.push(domainId),
		});
		source.recomputeDomain("bob-domain");
		source.teardown("bob-domain");
		expect(cancelled).toEqual(["bob-domain"]);
	});
});
