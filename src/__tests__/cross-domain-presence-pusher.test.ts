import { describe, expect, it, vi } from "vitest";
import { createCoalescedPresencePusher } from "../gateway/federation/crossDomainPresence.js";
import type { CrossDomainPresenceSession } from "../shared/federation-protocol.js";
import { session } from "./helpers/cross-domain-presence.js";

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
