import { describe, expect, it, vi } from "vitest";
import type { VaultValueAnswer } from "../shared/schemasVault.js";
import {
	askerOf,
	askpassBrief,
	createGatewayPort,
	type GatewayPort,
	HOLD_WAIT_MS,
	parseProcCmdline,
	RACE_WAIT_MS,
	runAskpass,
	secretPrompt,
	type TtyPort,
	WITHDRAW_TIMEOUT_MS,
} from "../vault-askpass/askpass.js";

/** Settles by hand, and records the abort it was given. */
function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const pending = (requestId: string, deadlineAt = Number.MAX_SAFE_INTEGER): VaultValueAnswer => ({
	outcome: "pending",
	requestId,
	deadlineAt,
});
const approved = (value: string): VaultValueAnswer => ({ outcome: "approved", decision: "once", value });

/** A gateway whose askpass answers at once and whose collect waits on the test. */
function fakeGateway(first: VaultValueAnswer | null) {
	const collects: Array<{ requestId: string; waitMs: number; settle: (a: VaultValueAnswer | null) => void }> = [];
	const asks: number[] = [];
	const withdrawn: string[] = [];
	const gateway: GatewayPort = {
		askpass: async (_cmdline, waitMs) => {
			asks.push(waitMs);
			return first;
		},
		collect: (requestId, waitMs, signal) => {
			const d = deferred<VaultValueAnswer | null>();
			signal.addEventListener("abort", () => d.resolve(null), { once: true });
			collects.push({ requestId, waitMs, settle: d.resolve });
			return d.promise;
		},
		withdraw: async (requestId) => {
			withdrawn.push(requestId);
		},
	};
	return { gateway, collects, asks, withdrawn };
}

/** One deferred per prompt; `type` answers the latest. */
function fakeTty() {
	const reads: Array<ReturnType<typeof deferred<string | null>>> = [];
	let aborted = false;
	const tty: TtyPort = {
		readSecret: (_prompt, signal) => {
			const d = deferred<string | null>();
			reads.push(d);
			signal.addEventListener("abort", () => {
				aborted = true;
				d.resolve(null);
			});
			return d.promise;
		},
	};
	return { tty, type: (value: string | null) => reads.at(-1)?.resolve(value), reads, aborted: () => aborted };
}

const input = { cmdline: "sudo apt install foo", prompt: "[sudo] password:" };
const now = () => 1_000;

describe("the askpass helper's race", () => {
	it("the tty answering first wins, and the phone's request is withdrawn", async () => {
		const g = fakeGateway(pending("req-1"));
		const t = fakeTty();
		const run = runAskpass(input, { gateway: g.gateway, tty: t.tty, now });
		await new Promise((r) => setTimeout(r, 0));
		expect(g.collects[0]).toMatchObject({ requestId: "req-1", waitMs: RACE_WAIT_MS });
		t.type("typed-secret");
		expect(await run).toEqual({ kind: "value", value: "typed-secret", from: "tty" });
		expect(g.withdrawn).toEqual(["req-1"]);
		// The opening call returns at once, so the request id is known before the human can win.
		expect(g.asks).toEqual([0]);
	});

	it("the phone answering first wins, and the tty read is abandoned", async () => {
		const g = fakeGateway(pending("req-2"));
		const t = fakeTty();
		const run = runAskpass(input, { gateway: g.gateway, tty: t.tty, now });
		await new Promise((r) => setTimeout(r, 0));
		g.collects[0].settle(approved("phone-secret"));
		expect(await run).toEqual({ kind: "value", value: "phone-secret", from: "phone" });
		expect(t.aborted()).toBe(true);
		expect(g.withdrawn).toEqual([]);
	});

	it("without a tty the helper holds on the phone with the long wait, collecting until it settles", async () => {
		const g = fakeGateway(pending("req-3"));
		const run = runAskpass(input, { gateway: g.gateway, tty: null, now });
		await new Promise((r) => setTimeout(r, 0));
		expect(g.asks).toEqual([0]);
		expect(g.collects[0]).toMatchObject({ requestId: "req-3", waitMs: HOLD_WAIT_MS });
		g.collects[0].settle(pending("req-3"));
		await new Promise((r) => setTimeout(r, 0));
		expect(g.collects).toHaveLength(2);
		g.collects[1].settle(approved("late-secret"));
		expect(await run).toEqual({ kind: "value", value: "late-secret", from: "phone" });
	});

	it("without a tty, a refusal, an unreachable gateway, and a passed deadline each end the helper", async () => {
		expect(
			await runAskpass(input, {
				gateway: fakeGateway({ outcome: "refused", reason: "no" }).gateway,
				tty: null,
				now,
			}),
		).toEqual({ kind: "refused" });
		expect(await runAskpass(input, { gateway: fakeGateway(null).gateway, tty: null, now })).toEqual({
			kind: "unreachable",
		});
		expect(await runAskpass(input, { gateway: fakeGateway(pending("old", 999)).gateway, tty: null, now })).toEqual({
			kind: "no-answer",
		});
	});

	it("the caller giving up abandons the tty and withdraws the phone's request", async () => {
		const g = fakeGateway(pending("req-4"));
		const t = fakeTty();
		const cancel = new AbortController();
		const run = runAskpass({ ...input, signal: cancel.signal }, { gateway: g.gateway, tty: t.tty, now });
		await new Promise((r) => setTimeout(r, 0));
		cancel.abort();
		expect(await run).toEqual({ kind: "no-answer" });
		expect(t.aborted()).toBe(true);
		expect(g.withdrawn).toEqual(["req-4"]);
	});

	it("with a tty, an unreachable gateway and an owner's refusal each leave the tty as the road", async () => {
		const unreachable = fakeTty();
		const run = runAskpass(input, { gateway: fakeGateway(null).gateway, tty: unreachable.tty, now });
		unreachable.type("typed-anyway");
		expect(await run).toEqual({ kind: "value", value: "typed-anyway", from: "tty" });

		const refused = fakeTty();
		const declined = runAskpass(input, {
			gateway: fakeGateway({ outcome: "refused", reason: "no" }).gateway,
			tty: refused.tty,
			now,
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(refused.aborted()).toBe(false);
		refused.type("typed-after-refusal");
		expect(await declined).toEqual({ kind: "value", value: "typed-after-refusal", from: "tty" });
	});

	it("an empty line asks again while the phone road keeps running; a closed tty leaves the phone alone", async () => {
		const g = fakeGateway(pending("req-5"));
		const t = fakeTty();
		const run = runAskpass(input, { gateway: g.gateway, tty: t.tty, now });
		await new Promise((r) => setTimeout(r, 0));
		t.type("");
		await new Promise((r) => setTimeout(r, 0));
		expect(t.reads).toHaveLength(2);
		expect(g.withdrawn).toEqual([]);
		t.type("second-try");
		expect(await run).toEqual({ kind: "value", value: "second-try", from: "tty" });
		expect(g.withdrawn).toEqual(["req-5"]);

		const closed = fakeGateway(pending("req-7"));
		const eof = fakeTty();
		const held = runAskpass(input, { gateway: closed.gateway, tty: eof.tty, now });
		await new Promise((r) => setTimeout(r, 0));
		eof.type(null);
		await new Promise((r) => setTimeout(r, 0));
		expect(eof.reads).toHaveLength(1);
		closed.collects[0].settle(approved("phone-after-eof"));
		expect(await held).toEqual({ kind: "value", value: "phone-after-eof", from: "phone" });
	});

	it("a signal already aborted opens nothing", async () => {
		const g = fakeGateway(pending("req-6"));
		const cancel = new AbortController();
		cancel.abort();
		expect(await runAskpass({ ...input, signal: cancel.signal }, { gateway: g.gateway, tty: null, now })).toEqual({
			kind: "no-answer",
		});
		expect(g.asks).toEqual([]);
	});
});

describe("the askpass brief", () => {
	it("joins a NUL-separated cmdline and drops sudo's askpass flag ahead of the command", () => {
		expect(parseProcCmdline("sudo\0-A\0apt\0install\0foo\0")).toBe("sudo -A apt install foo");
		expect(parseProcCmdline(new TextEncoder().encode("ssh\0deploy@prod\0"))).toBe("ssh deploy@prod");
		expect(askpassBrief("sudo -A apt install foo")).toBe("sudo apt install foo");
		expect(askpassBrief("/usr/bin/sudo -A -u root grep -A 3 foo")).toBe("/usr/bin/sudo -u root grep -A 3 foo");
		expect(askpassBrief("sudo -u root -A -- ls -A")).toBe("sudo -u root -- ls -A");
		expect(askpassBrief("sudo -AH --askpass -u -A apt")).toBe("sudo -H -u -A apt");
		expect(askpassBrief("git-remote-https origin https://x")).toBe("git-remote-https origin https://x");
		// The executable path stands in for a renamed first word.
		expect(askpassBrief("ssh deploy@prod", "/tmp/evil")).toBe("/tmp/evil deploy@prod");
		expect(askpassBrief("sudo -A apt", "/usr/bin/sudo")).toBe("/usr/bin/sudo apt");
	});

	it("the asker is the parent's pid and start ticks, read past a comm that holds spaces and parens", () => {
		expect(
			askerOf(
				2584370,
				"2584370 (sudo) S 2584367 2584367 2584367 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 14831454 1 2 3",
			),
		).toBe("2584370:14831454");
		expect(askerOf(7, "7 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99 0")).toBe("7:99");
		expect(askerOf(7, "7 (short) S 1 2")).toBeNull();
		expect(askerOf(7, "garbage")).toBeNull();
	});

	it("only a password or passphrase prompt goes to the phone", () => {
		for (const prompt of ["[sudo] password for me:", "Enter passphrase for key '/x':", "Password:", "", "PIN:"])
			expect(secretPrompt(prompt)).toBe(true);
		for (const prompt of [
			"Are you sure you want to continue connecting (yes/no/[fingerprint])?",
			"Username for 'https://github.com':",
			"Verification code:",
		])
			expect(secretPrompt(prompt)).toBe(false);
	});
});

describe("the gateway port", () => {
	it("posts under the helper token, reads answers, and treats anything else as the road closed", async () => {
		const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
		const answers: Array<() => Response> = [
			() => Response.json({ outcome: "pending", requestId: "r", deadlineAt: 5 }),
			() => Response.json({ error: "not found" }, { status: 404 }),
			() => {
				throw new Error("refused connection");
			},
			() => new Response("ok"),
		];
		const port = createGatewayPort({
			baseUrl: "http://gw",
			token: "tok",
			sessionToken: "sess",
			fetch: async (url, init) => {
				seen.push({
					url,
					headers: init.headers as Record<string, string>,
					body: JSON.parse(String(init.body)),
				});
				return (answers.shift() as () => Response)();
			},
		});
		const signal = new AbortController().signal;
		expect(await port.askpass("sudo apt", 10, signal, "42:7")).toEqual({
			outcome: "pending",
			requestId: "r",
			deadlineAt: 5,
		});
		expect(seen[0]).toMatchObject({
			url: "http://gw/vault/askpass",
			headers: { "x-vault-helper-token": "tok", "x-session-token": "sess" },
			body: { cmdline: "sudo apt", waitMs: 10, asker: "42:7" },
		});
		expect(await port.collect("r", 10, signal)).toBeNull();
		expect(await port.collect("r", 10, signal)).toBeNull();
		await port.withdraw("r");
		expect(seen[3]).toMatchObject({ url: "http://gw/vault/withdraw", body: { requestId: "r" } });
	});

	it("an abort answers null even when the transport never settles, and a withdraw is bounded", async () => {
		const port = createGatewayPort({
			baseUrl: "http://gw",
			token: "tok",
			fetch: () => new Promise(() => undefined),
		});
		const abort = new AbortController();
		const hanging = port.collect("r", 10, abort.signal);
		abort.abort();
		expect(await hanging).toBeNull();
		vi.useFakeTimers();
		try {
			const withdrawn = port.withdraw("r");
			await vi.advanceTimersByTimeAsync(WITHDRAW_TIMEOUT_MS + 1);
			await withdrawn;
		} finally {
			vi.useRealTimers();
		}
	});
});
