import { describe, expect, it, vi } from "vitest";
import {
	CrossDomainPresenceConsumer,
	createCoalescedPresencePusher,
	createCrossDomainPresenceSource,
	crossDomainPresencePlaneName,
	crossDomainPresenceSourcePlaneName,
} from "../gateway/federation/crossDomainPresence.js";
import type { CrossDomainPresenceSession } from "../shared/federation-protocol.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

function session(team: string, overrides: Partial<CrossDomainPresenceSession> = {}): CrossDomainPresenceSession {
	return { team, gatewayId: "gw-a", status: "online", kind: "devcontainer", queueDepth: 0, ...overrides };
}

const noopCancel = () => {};
const noopInvalidate = () => {};

describe("CrossDomainPresenceConsumer (landing side)", () => {
	it("land() lazily registers a per-Domain plane and stores what was pushed", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		expect(registry.hasPlane(crossDomainPresencePlaneName("bob-domain"))).toBe(false);

		consumer.land("bob-domain", [session("story")]);
		expect(registry.hasPlane(crossDomainPresencePlaneName("bob-domain"))).toBe(true);
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
	});

	it("a second land() with IDENTICAL session content never bumps the version (a freshness-only refresh)", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [session("story")]);
		const before = registry.version(crossDomainPresencePlaneName("bob-domain"));

		consumer.land("bob-domain", [session("story")]); // same content, different lastPushedAt internally
		expect(registry.version(crossDomainPresencePlaneName("bob-domain"))).toEqual(before);
	});

	it("a second land() with DIFFERENT session content bumps the version", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [session("story")]);
		const before = registry.version(crossDomainPresencePlaneName("bob-domain"));

		consumer.land("bob-domain", [session("story"), session("app")]);
		expect(registry.version(crossDomainPresencePlaneName("bob-domain"))?.counter).toBe((before?.counter ?? 0) + 1);
	});

	it("two different Domains get two independent planes - one's push never touches the other's", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [session("story")]);
		consumer.land("carol-domain", [session("app")]);

		const bobBefore = registry.version(crossDomainPresencePlaneName("bob-domain"));
		consumer.land("carol-domain", [session("app"), session("app2")]);
		expect(registry.version(crossDomainPresencePlaneName("bob-domain"))).toEqual(bobBefore);
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
	});

	it("teardown drops the stored state and the plane, so a later land() starts fresh", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [session("story")]);
		consumer.teardown("bob-domain");

		expect(consumer.snapshot()["bob-domain"]).toBeUndefined();
		expect(registry.hasPlane(crossDomainPresencePlaneName("bob-domain"))).toBe(false);

		// Re-linked later: registers clean (baseline seeded empty, since ensureRegistered runs before
		// this call's own state write), then the immediate content write is one real, counted change -
		// unlike the source side, the consumer side needs no separate cold-start bypass for this.
		consumer.land("bob-domain", [session("story")]);
		expect(registry.version(crossDomainPresencePlaneName("bob-domain"))?.counter).toBe(1);
	});

	it("restore() seeds prior state so a friend's last-known sessions survive a clean restart", () => {
		const registryA = new PlaneRegistry();
		const consumerA = new CrossDomainPresenceConsumer(registryA, undefined);
		consumerA.land("bob-domain", [session("story")]);

		const registryB = new PlaneRegistry();
		const consumerB = new CrossDomainPresenceConsumer(registryB, undefined);
		consumerB.restore(consumerA.snapshot());
		expect(consumerB.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
	});

	it("restore() immediately re-registers every restored Domain's plane (not lazily on its next land())", () => {
		const registryA = new PlaneRegistry();
		const consumerA = new CrossDomainPresenceConsumer(registryA, undefined, 0);
		consumerA.land("bob-domain", [session("story")]);

		const registryB = new PlaneRegistry();
		const consumerB = new CrossDomainPresenceConsumer(registryB, undefined, 0);
		consumerB.restore(consumerA.snapshot());
		expect(registryB.hasPlane(crossDomainPresencePlaneName("bob-domain"))).toBe(true);
	});

	it("teardown purges state restored from a prior process, even with no intervening land() in this one", () => {
		const registryA = new PlaneRegistry();
		const consumerA = new CrossDomainPresenceConsumer(registryA, undefined, 0);
		consumerA.land("friend-domain", [session("story")]);

		const registryB = new PlaneRegistry();
		const consumerB = new CrossDomainPresenceConsumer(registryB, undefined, 0);
		consumerB.restore(consumerA.snapshot());
		consumerB.teardown("friend-domain"); // no land() call on consumerB before this

		expect(consumerB.snapshot()["friend-domain"]).toBeUndefined();
		expect(registryB.hasPlane(crossDomainPresencePlaneName("friend-domain"))).toBe(false);
	});

	it("restore() enforces the cap across a restart, so a new Domain cannot land past it before an old one re-pushes", () => {
		const registryA = new PlaneRegistry();
		const consumerA = new CrossDomainPresenceConsumer(registryA, undefined, 0);
		for (let i = 0; i < 500; i++) consumerA.land(`domain-${i}`, [session("story")]);

		const registryB = new PlaneRegistry();
		const consumerB = new CrossDomainPresenceConsumer(registryB, undefined, 0);
		consumerB.restore(consumerA.snapshot());
		expect(registryB.hasPlane(crossDomainPresencePlaneName("domain-499"))).toBe(true);

		consumerB.land("domain-500", [session("story")]); // the 501st distinct Domain, post-restart
		expect(registryB.hasPlane(crossDomainPresencePlaneName("domain-500"))).toBe(false);
		expect(consumerB.snapshot()["domain-500"]).toBeUndefined();
	});

	it("a malformed restore payload starts empty rather than throwing", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		expect(() => consumer.restore({ garbage: true })).not.toThrow();
		expect(consumer.snapshot()).toEqual({});
	});

	it('a domainId of "__proto__" cannot corrupt the store\'s prototype chain (state is a Map, not a plain object)', () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("__proto__", [session("story")]);
		// If this were a plain-object bracket assignment, Object.prototype would now be hijacked -
		// a totally unrelated fresh object would inherit the injected fields.
		expect(({} as Record<string, unknown>).sessions).toBeUndefined();
		// snapshot() uses Object.fromEntries, which defines an OWN data property (bypassing the
		// legacy accessor) - so "__proto__" lands as an ordinary key, and the object's REAL
		// prototype is untouched.
		expect(Object.getPrototypeOf(consumer.snapshot())).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(consumer.snapshot(), "__proto__")?.value).toEqual({
			sessions: [session("story")],
			lastPushedAt: expect.any(Number),
		});
	});

	it('restore() cannot be corrupted by a persisted "__proto__" key either (the READ side, not just land()\'s write side)', () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		// A JSON.parse round-trip, not an object literal: only CreateDataProperty (what JSON.parse
		// uses) reaches z.record's Reflect.ownKeys(input) loop the way a real durable-state file load
		// would - a literal `{ "__proto__": ... }` in source sets the prototype at creation instead.
		const payload = JSON.parse(
			JSON.stringify({
				"bob-domain": { sessions: [session("story")], lastPushedAt: 0 },
				__proto__: { sessions: [session("evil")], lastPushedAt: 0 },
			}),
		);
		consumer.restore(payload);
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
		expect(Object.getPrototypeOf(consumer.snapshot())).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(consumer.snapshot(), "__proto__")).toBeUndefined();
	});

	it("land() sanitizes control/bidi characters out of sessionLabel/description before storing", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [
			session("story", { sessionLabel: "evil‮label", description: "line1\ndescription" }),
		]);
		const stored = consumer.snapshot()["bob-domain"]?.sessions[0];
		// sanitizeLabel REJECTS a label containing any forbidden character outright (never partial-
		// strips it, unlike sanitizeDescription) - a bidi-override label becomes absent, not cleaned.
		expect(stored?.sessionLabel).toBeUndefined();
		expect(stored?.description).not.toContain("\n");
		expect(stored?.description).toBe("line1 description");
	});

	it("land() sanitizes EVERY session in one call, not just the first", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [
			session("story", { description: "clean" }),
			session("app", { sessionLabel: "evil‮label" }),
		]);
		const stored = consumer.snapshot()["bob-domain"]?.sessions;
		expect(stored?.[0]?.description).toBe("clean");
		expect(stored?.[1]?.sessionLabel).toBeUndefined(); // the SECOND session's label was sanitized too
	});

	it("land() sanitizes control/bidi characters out of team/gatewayId too, falling back rather than going empty", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		consumer.land("bob-domain", [session("evil‮team", { gatewayId: "line1\ngw" })]);
		const stored = consumer.snapshot()["bob-domain"]?.sessions[0];
		expect(stored?.team).not.toContain("‮");
		expect(stored?.gatewayId).toBe("line1 gw");
	});

	it("a Domain refused at the cap is never written into state (no orphaned entry, no un-teardownable leak)", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0); // no rate limit - not what these tests exercise
		for (let i = 0; i < 500; i++) consumer.land(`domain-${i}`, [session("story")]);
		expect(registry.hasPlane(crossDomainPresencePlaneName("domain-499"))).toBe(true);

		consumer.land("domain-500", [session("story")]); // the 501st distinct Domain
		expect(registry.hasPlane(crossDomainPresencePlaneName("domain-500"))).toBe(false);
		expect(consumer.snapshot()["domain-500"]).toBeUndefined(); // not silently written anyway

		// An already-tracked Domain's own updates are unaffected by the cap.
		consumer.land("domain-0", [session("story"), session("app")]);
		expect(consumer.snapshot()["domain-0"]?.sessions).toHaveLength(2);
	});

	it("defers (never drops) a land() arriving within the minimum interval of the last one from the SAME Domain", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
			consumer.land("bob-domain", [session("story")]);
			consumer.land("bob-domain", [session("story"), session("app")]); // arrives immediately after
			// Not yet applied - coalesced behind a timer, not written straight to state (a hostile/buggy
			// peer resending fast must not force repeated full work).
			expect(consumer.snapshot()["bob-domain"]?.sessions).toHaveLength(1);

			vi.advanceTimersByTime(1_000);
			// The deferred (more current) payload lands once the window elapses - never permanently lost.
			expect(consumer.snapshot()["bob-domain"]?.sessions).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a second land() deferred within the same window replaces the pending payload rather than queuing it", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
			consumer.land("bob-domain", [session("story")]);
			consumer.land("bob-domain", [session("story"), session("app")]); // deferred #1
			consumer.land("bob-domain", [session("story"), session("app"), session("gemini")]); // supersedes #1

			vi.advanceTimersByTime(1_000);
			// Only ONE deferred write ever applies - the latest payload, not an intermediate one.
			expect(consumer.snapshot()["bob-domain"]?.sessions).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("teardown cancels a pending deferred land, so it never applies after the Domain is gone", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
			consumer.land("bob-domain", [session("story")]);
			consumer.land("bob-domain", [session("story"), session("app")]); // deferred
			consumer.teardown("bob-domain");

			vi.advanceTimersByTime(1_000);
			expect(consumer.snapshot()["bob-domain"]).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts a land() once the minimum interval has actually elapsed", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
			consumer.land("bob-domain", [session("story")]);
			vi.advanceTimersByTime(1_000);
			consumer.land("bob-domain", [session("story"), session("app")]);
			expect(consumer.snapshot()["bob-domain"]?.sessions).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rate-limits independently per Domain - a burst from one Domain never blocks another's", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
		consumer.land("bob-domain", [session("story")]);
		consumer.land("carol-domain", [session("app")]); // a different Domain, same instant
		expect(consumer.snapshot()["carol-domain"]?.sessions).toEqual([session("app")]);
	});

	it("teardown clears the rate-limit tracker, so a re-linked Domain's first land() is never dropped", () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
		consumer.land("bob-domain", [session("story")]);
		consumer.teardown("bob-domain");
		consumer.land("bob-domain", [session("app")]); // immediately re-linked and pushed
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("app")]);
	});
});

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

describe("createCoalescedPresencePusher", () => {
	it("a single push calls sendOnce exactly once with that payload", async () => {
		const calls: Array<CrossDomainPresenceSession[]> = [];
		const pusher = createCoalescedPresencePusher(async (_domainId, sessions) => {
			calls.push(sessions);
			return { ok: true };
		});
		pusher.push("bob-domain", [session("story")]);
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toEqual([[session("story")]]);
	});

	it("a push arriving while one is in-flight REPLACES the payload rather than queuing a second send", async () => {
		let resolveFirst: ((v: { ok: boolean }) => void) | undefined;
		const calls: Array<CrossDomainPresenceSession[]> = [];
		const pusher = createCoalescedPresencePusher((_domainId, sessions) => {
			calls.push(sessions);
			return new Promise((resolve) => {
				resolveFirst = resolve;
			});
		});

		pusher.push("bob-domain", [session("story")]); // first attempt starts, stays in flight
		pusher.push("bob-domain", [session("story"), session("app")]); // supersedes it before it settles

		expect(calls).toHaveLength(1); // no second send fired while the first is still in flight
		resolveFirst?.({ ok: true });
		await new Promise((r) => setTimeout(r, 0));
		// The superseded payload's own success does not end the sequence - the fresher one still
		// goes out right after, as a fresh attempt.
		expect(calls).toEqual([[session("story")], [session("story"), session("app")]]);
	});

	it("a REJECTED (thrown) sendOnce is retried exactly like an {ok:false} resolution, using the latest payload", async () => {
		vi.useFakeTimers();
		try {
			const calls: Array<CrossDomainPresenceSession[]> = [];
			let attempt = 0;
			const pusher = createCoalescedPresencePusher(async (_domainId, sessions) => {
				calls.push(sessions);
				attempt += 1;
				if (attempt === 1) throw new Error("network blip");
				return { ok: true };
			});
			pusher.push("bob-domain", [session("story")]);
			await vi.advanceTimersByTimeAsync(0); // the first attempt throws instead of resolving false
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(2000); // same backoff a normal {ok:false} would get
			expect(calls).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a payload superseding a REJECTED attempt is sent fresh, not silently dropped", async () => {
		let rejectFirst: ((err: Error) => void) | undefined;
		const calls: Array<CrossDomainPresenceSession[]> = [];
		const pusher = createCoalescedPresencePusher((_domainId, sessions) => {
			calls.push(sessions);
			return new Promise((_resolve, reject) => {
				rejectFirst = reject;
			});
		});

		pusher.push("bob-domain", [session("story")]); // first attempt starts, stays in flight
		pusher.push("bob-domain", [session("story"), session("app")]); // supersedes it before it settles
		expect(calls).toHaveLength(1);

		rejectFirst?.(new Error("network blip"));
		await new Promise((r) => setTimeout(r, 0));
		// The superseded attempt's own rejection does not end the sequence - the fresher payload
		// still goes out right after, exactly as it would had the superseded attempt merely failed.
		expect(calls).toEqual([[session("story")], [session("story"), session("app")]]);
	});

	it("a failed attempt retries with backoff, using whatever payload is current at retry time", async () => {
		vi.useFakeTimers();
		try {
			const calls: Array<CrossDomainPresenceSession[]> = [];
			let attempt = 0;
			const pusher = createCoalescedPresencePusher(async (_domainId, sessions) => {
				calls.push(sessions);
				attempt += 1;
				return attempt < 2 ? { ok: false, error: "transient" } : { ok: true };
			});
			pusher.push("bob-domain", [session("story")]);
			await vi.advanceTimersByTimeAsync(0); // let the first (failing) attempt's promise settle
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(2000); // the first backoff delay
			expect(calls).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up and logs after exhausting retries, without throwing", async () => {
		vi.useFakeTimers();
		try {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const pusher = createCoalescedPresencePusher(async () => ({ ok: false, error: "still failing" }));
			expect(() => pusher.push("bob-domain", [session("story")])).not.toThrow();
			// 5 attempts total: the first fires immediately, the rest after 2s/4s/8s/16s backoff.
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(2000);
			await vi.advanceTimersByTimeAsync(4000);
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(16000);
			expect(error).toHaveBeenCalledWith(expect.stringContaining("bob-domain"));
			error.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancel drops a pending payload so an in-flight attempt's eventual settle is a no-op", async () => {
		let resolveFirst: ((v: { ok: boolean }) => void) | undefined;
		const calls: Array<CrossDomainPresenceSession[]> = [];
		const pusher = createCoalescedPresencePusher((_domainId, sessions) => {
			calls.push(sessions);
			return new Promise((resolve) => {
				resolveFirst = resolve;
			});
		});
		pusher.push("bob-domain", [session("story")]);
		pusher.cancel("bob-domain");
		resolveFirst?.({ ok: true });
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toHaveLength(1); // the settle was a no-op, not a retry or a resurrection

		// A fresh push after cancel starts a genuinely new attempt, not coalesced behind nothing.
		pusher.push("bob-domain", [session("app")]);
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toEqual([[session("story")], [session("app")]]);
	});

	it("cancel then an immediate re-push never causes a duplicate dispatch when the stale attempt later settles", async () => {
		const resolvers: Array<(v: { ok: boolean }) => void> = [];
		const calls: Array<CrossDomainPresenceSession[]> = [];
		const pusher = createCoalescedPresencePusher((_domainId, sessions) => {
			calls.push(sessions);
			return new Promise((resolve) => {
				resolvers.push(resolve);
			});
		});
		pusher.push("bob-domain", [session("story")]); // attempt #1 (story) starts, stays in flight
		pusher.cancel("bob-domain");
		pusher.push("bob-domain", [session("app")]); // a fresh attempt (app), dispatched before story settles
		expect(calls).toEqual([[session("story")], [session("app")]]);

		resolvers[0]?.({ ok: true }); // the STALE (story) attempt finally settles, long after being cancelled
		await new Promise((r) => setTimeout(r, 0));
		// The stale settle must recognize it belongs to a superseded generation and do nothing - not
		// re-dispatch a redundant, concurrent second send of "app" (which already went out above).
		expect(calls).toEqual([[session("story")], [session("app")]]);
	});
});
