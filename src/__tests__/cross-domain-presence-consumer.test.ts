import { describe, expect, it, vi } from "vitest";
import {
	CrossDomainPresenceConsumer,
	crossDomainPresencePlaneName,
} from "../gateway/federation/crossDomainPresence.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { session } from "./helpers/cross-domain-presence.js";

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

		consumer.land("bob-domain", [session("story")]); // same content, different lastRefreshedAt internally
		expect(registry.version(crossDomainPresencePlaneName("bob-domain"))).toEqual(before);
	});

	it("a second land() with IDENTICAL content still bumps once the freshness bucket advances, carrying a fresher lastRefreshedAt to the console", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0);
			consumer.land("bob-domain", [session("story")]);
			const before = registry.version(crossDomainPresencePlaneName("bob-domain"));
			const firstRefresh = consumer.snapshot()["bob-domain"]?.lastRefreshedAt;

			vi.advanceTimersByTime(61_000); // cross into a new freshness bucket
			consumer.land("bob-domain", [session("story")]); // identical content, just a reconfirmation

			const after = registry.version(crossDomainPresencePlaneName("bob-domain"));
			expect(after?.counter).toBe((before?.counter ?? 0) + 1); // bumped, so this reaches a poll
			expect(consumer.snapshot()["bob-domain"]?.lastRefreshedAt).toBeGreaterThan(firstRefresh ?? 0);
		} finally {
			vi.useRealTimers();
		}
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
			lastRefreshedAt: expect.any(Number),
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
				"bob-domain": { sessions: [session("story")], lastRefreshedAt: 0 },
				__proto__: { sessions: [session("evil")], lastRefreshedAt: 0 },
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
