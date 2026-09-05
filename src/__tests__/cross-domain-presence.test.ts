import { describe, expect, it, vi } from "vitest";
import {
	CrossDomainPresenceConsumer,
	createCoalescedPresencePusher,
	createCrossDomainPresenceReconciler,
	createCrossDomainPresenceSource,
	crossDomainPresencePlaneName,
	crossDomainPresenceSourcePlaneName,
} from "../gateway/federation/crossDomainPresence.js";
import { type CrossDomainPresenceSession, MAX_CROSSDOMAIN_PRESENCE_SESSIONS } from "../shared/federation-protocol.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { presenceForDomain, toCrossDomainPresenceSession } from "../shared/presence-projection.js";
import { Address } from "../shared/session-id.js";
import type { TeamInfo } from "../shared/types.js";

const session = (team: string, over: Partial<TeamInfo> = {}): TeamInfo => ({
	team,
	gatewayId: "gateway",
	status: "online",
	kind: "devcontainer",
	queue_depth: 2,
	...over,
});

const address = (team: string) => Address.local("local", "gateway", ...(team.split(".") as [string, string]));

const landed = (team: string, over: Partial<CrossDomainPresenceSession> = {}): CrossDomainPresenceSession => ({
	team,
	gatewayId: "gateway",
	status: "online",
	kind: "devcontainer",
	queueDepth: 2,
	...over,
});

describe("cross-domain presence projection", () => {
	it("projects allowed kinds and truncates fields", () => {
		const result = toCrossDomainPresenceSession(
			session("app.chat", {
				sessionLabel: "x".repeat(100),
				description: "y".repeat(150),
			}),
			address,
		);
		expect(result).toEqual({
			team: "app.chat",
			gatewayId: "gateway",
			status: "online",
			kind: "devcontainer",
			sessionLabel: "x".repeat(64),
			description: "y".repeat(120),
			queueDepth: 2,
		});
		expect(toCrossDomainPresenceSession(session("app.chat", { kind: "console" as never }), address)).toBeNull();
		expect(toCrossDomainPresenceSession(session("missing"), () => null)).toBeNull();
	});

	it("selects shared sessions by canonical address and caps the result", () => {
		const local = Array.from({ length: MAX_CROSSDOMAIN_PRESENCE_SESSIONS + 1 }, (_, i) => session(`app${i}.chat`));
		const result = presenceForDomain("friend", local, () => local.map((t) => address(t.team).canonical), address);
		expect(result).toHaveLength(MAX_CROSSDOMAIN_PRESENCE_SESSIONS);
		expect(result[0]?.team).toBe("app0.chat");
	});

	it("accepts loose sessions and excludes unshared or unresolved rows", () => {
		const local = [session("one.chat", { kind: "loose" }), session("two.chat")];
		const result = presenceForDomain("friend", local, () => [address("one.chat").canonical], address);
		expect(result.map((row: CrossDomainPresenceSession) => row.team)).toEqual(["one.chat"]);
	});
});

describe("cross-domain presence landing", () => {
	it("stores sanitized content, defers a burst, and restores the cap and teardown state", () => {
		vi.useFakeTimers();
		try {
			const registry = new PlaneRegistry();
			const consumer = new CrossDomainPresenceConsumer(registry, undefined, 1_000);
			const unsafe = landed("story", { sessionLabel: "bad\u202elabel", description: "one\ntwo" });
			consumer.land("friend", [unsafe]);
			consumer.land("friend", [unsafe, landed("app")]);
			consumer.land("friend", [unsafe, landed("app"), landed("gemini")]);
			expect(consumer.snapshot().friend?.sessions).toHaveLength(1);

			vi.advanceTimersByTime(1_000);
			expect(consumer.snapshot().friend?.sessions).toHaveLength(3);
			expect(consumer.snapshot().friend?.sessions[0]).toMatchObject({ description: "one two" });
			expect(consumer.snapshot().friend?.sessions[0]?.sessionLabel).toBeUndefined();
			const beforeFreshness = registry.version(crossDomainPresencePlaneName("friend"));
			vi.advanceTimersByTime(60_000);
			consumer.land("friend", consumer.snapshot().friend?.sessions ?? []);
			expect(registry.version(crossDomainPresencePlaneName("friend"))?.counter).toBe(
				(beforeFreshness?.counter ?? 0) + 1,
			);

			const restored = new CrossDomainPresenceConsumer(new PlaneRegistry(), undefined, 0);
			restored.restore(consumer.snapshot());
			restored.teardown("friend");
			restored.land("friend", [landed("relinked")]);
			expect(restored.snapshot().friend?.sessions[0]?.team).toBe("relinked");
			for (let i = 0; i < 500; i++) restored.land(`domain-${i}`, [landed("story")]);
			expect(restored.ensureRegistered("domain-500")).toBe(false);
			expect(restored.snapshot().friend?.sessions[0]?.team).toBe("relinked");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("cross-domain presence pusher", () => {
	it("coalesces fresh content, retries failures, and ignores canceled generations", async () => {
		vi.useFakeTimers();
		try {
			let remote: CrossDomainPresenceSession[] = [];
			let answer: { ok: boolean } = { ok: false };
			let first = true;
			let resolveFirst: ((value: { ok: boolean }) => void) | undefined;
			const pusher = createCoalescedPresencePusher(async (_domainId, sessions) => {
				if (first) {
					first = false;
					return new Promise((resolve) => (resolveFirst = resolve));
				}
				if (!answer.ok) return answer;
				remote = sessions;
				return answer;
			});

			pusher.push("friend", [landed("story")]);
			pusher.push("friend", [landed("story"), landed("app")]);
			answer = { ok: true };
			resolveFirst?.({ ok: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(remote.map((row) => row.team)).toEqual(["story", "app"]);

			remote = [];
			answer = { ok: false };
			pusher.push("friend", [landed("retry")]);
			await vi.advanceTimersByTimeAsync(0);
			answer = { ok: true };
			await vi.advanceTimersByTimeAsync(2_000);
			expect(remote[0]?.team).toBe("retry");

			let resolveStale: ((value: { ok: boolean }) => void) | undefined;
			const canceled = createCoalescedPresencePusher(async (_domainId, sessions) => {
				if (sessions[0]?.team === "stale") return new Promise((resolve) => (resolveStale = resolve));
				remote = sessions;
				return { ok: true };
			});
			remote = [];
			canceled.push("friend", [landed("stale")]);
			canceled.cancel("friend");
			canceled.push("friend", [landed("fresh")]);
			resolveStale?.({ ok: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(remote[0]?.team).toBe("fresh");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("cross-domain presence reconciliation", () => {
	it("keeps state on an unavailable pull, suppresses overlap, and permits a fresh pull after cancel", async () => {
		const registry = new PlaneRegistry();
		const consumer = new CrossDomainPresenceConsumer(registry, undefined, 0);
		consumer.land("friend", [landed("prior")]);
		let resolvePull: ((value: CrossDomainPresenceSession[] | null) => void) | undefined;
		let source = ["friend"];
		const reconciler = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => source,
			pull: () => new Promise((resolve) => (resolvePull = resolve)),
			land: (domainId, sessions) => consumer.land(domainId, sessions),
		});
		reconciler.tick();
		reconciler.tick();
		reconciler.cancel("friend");
		resolvePull?.([landed("stale")]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumer.snapshot().friend?.sessions[0]?.team).toBe("prior");

		const answers: Array<CrossDomainPresenceSession[] | null> = [null, [landed("current")]];
		const next = createCrossDomainPresenceReconciler({
			linkedDomainIds: () => source,
			pull: async () => answers.shift() ?? null,
			land: (domainId, sessions) => consumer.land(domainId, sessions),
		});
		next.tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumer.snapshot().friend?.sessions[0]?.team).toBe("prior");
		next.tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumer.snapshot().friend?.sessions[0]?.team).toBe("current");
		source = [];
	});
});

describe("cross-domain presence source", () => {
	it("pushes cold content, suppresses unchanged content, and starts fresh after teardown", () => {
		const registry = new PlaneRegistry();
		let current = [landed("story")];
		let linked = ["friend"];
		let cached: CrossDomainPresenceSession[] | undefined;
		let remote: CrossDomainPresenceSession[] = [];
		const source = createCrossDomainPresenceSource({
			planeRegistry: registry,
			restoredPlanes: undefined,
			presenceForDomain: () => (cached ??= current),
			linkedAndSharedDomainIds: () => linked,
			invalidatePresenceCache: () => {
				cached = undefined;
			},
			push: (_domainId, sessions) => (remote = sessions),
			cancelPush: () => {},
		});
		source.recomputeDomain("friend");
		expect(remote.map((row) => row.team)).toEqual(["story"]);
		source.recomputeDomain("friend");
		current = [landed("app"), landed("story")];
		source.recomputeDomain("friend");
		expect(remote.map((row) => row.team)).toEqual(["app", "story"]);
		linked = [];
		source.recomputeDomain("friend");
		expect(registry.hasPlane(crossDomainPresenceSourcePlaneName("friend"))).toBe(false);
		linked = ["friend"];
		source.recomputeDomain("friend");
		expect(remote.map((row) => row.team)).toEqual(["app", "story"]);
	});
});
