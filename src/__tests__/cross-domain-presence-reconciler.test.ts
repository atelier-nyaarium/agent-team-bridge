import { describe, expect, it, vi } from "vitest";
import {
	CrossDomainPresenceConsumer,
	createCrossDomainPresenceReconciler,
} from "../gateway/federation/crossDomainPresence.js";
import type { CrossDomainPresenceSession } from "../shared/federation-protocol.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { session } from "./helpers/cross-domain-presence.js";

describe("createCrossDomainPresenceReconciler", () => {
	it("a tick pulls every currently-linked Domain and lands a successful result", async () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0);
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: async () => [session("story")],
			land: (domainId, sessions) => consumer.land(domainId, sessions),
		});
		reconciler.tick();
		await new Promise((r) => setTimeout(r, 0));
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
	});

	it("a null pull (every gateway unreachable) never overwrites existing landed state with emptiness", async () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0);
		consumer.land("bob-domain", [session("story")]);
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: async () => null,
			land: (domainId, sessions) => consumer.land(domainId, sessions),
		});
		reconciler.tick();
		await new Promise((r) => setTimeout(r, 0));
		expect(consumer.snapshot()["bob-domain"]?.sessions).toEqual([session("story")]);
	});

	it("a Domain still mid-attempt from a prior tick is skipped, not piled onto", async () => {
		let pullCalls = 0;
		let resolvePull: ((v: CrossDomainPresenceSession[] | null) => void) | undefined;
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: () => {
				pullCalls += 1;
				return new Promise((resolve) => {
					resolvePull = resolve;
				});
			},
			land: () => {},
		});
		reconciler.tick(); // starts the (not-yet-resolved) first attempt
		reconciler.tick(); // a second tick while the first is still in flight
		expect(pullCalls).toBe(1); // the in-flight guard skipped the second tick's own attempt

		resolvePull?.(null);
		await new Promise((r) => setTimeout(r, 0));
		reconciler.tick(); // the first attempt has now settled - a fresh attempt is allowed again
		expect(pullCalls).toBe(2);
	});

	it("a rejected pull is caught and logged, never thrown, and clears the in-flight guard for the next tick", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let pullCalls = 0;
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: async () => {
				pullCalls += 1;
				throw new Error("network blip");
			},
			land: () => {},
		});
		expect(() => reconciler.tick()).not.toThrow();
		await new Promise((r) => setTimeout(r, 0));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("bob-domain"));

		reconciler.tick(); // the in-flight guard was cleared despite the rejection
		await new Promise((r) => setTimeout(r, 0));
		expect(pullCalls).toBe(2);
		warn.mockRestore();
	});

	it("enumerates linkedDomainIds fresh on every tick, never a cached roster", async () => {
		let ids = ["bob-domain"];
		const pulled: string[] = [];
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ids,
			pull: async (domainId) => {
				pulled.push(domainId);
				return null;
			},
			land: () => {},
		});
		reconciler.tick();
		await new Promise((r) => setTimeout(r, 0));
		ids = ["bob-domain", "carol-domain"];
		reconciler.tick();
		await new Promise((r) => setTimeout(r, 0));
		expect(pulled).toEqual(["bob-domain", "bob-domain", "carol-domain"]);
	});

	it("cancel drops an in-flight pull's eventual resolution as a no-op, never resurrecting torn-down state", async () => {
		let resolvePull: ((v: CrossDomainPresenceSession[] | null) => void) | undefined;
		const landed: string[] = [];
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: () =>
				new Promise((resolve) => {
					resolvePull = resolve;
				}),
			land: (domainId) => landed.push(domainId),
		});
		reconciler.tick(); // starts the (not-yet-resolved) pull
		reconciler.cancel("bob-domain"); // simulates unlinkDomain running while the pull is in flight

		resolvePull?.([session("story")]); // the stale pull finally answers (e.g. a slow second gateway)
		await new Promise((r) => setTimeout(r, 0));
		expect(landed).toEqual([]); // never resurrected - the cancelled attempt's resolution is a no-op
	});

	it("cancel does not block a FRESH pull for the same Domain on a later tick", async () => {
		const landed: string[] = [];
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => ["bob-domain"],
			pull: async () => [session("story")],
			land: (domainId) => landed.push(domainId),
		});
		reconciler.cancel("bob-domain"); // nothing pending yet - a harmless no-op
		reconciler.tick();
		await new Promise((r) => setTimeout(r, 0));
		expect(landed).toEqual(["bob-domain"]); // the fresh dispatch was not wrongly suppressed
	});
});
