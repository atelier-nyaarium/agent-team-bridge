import type { HostOp, HostPeekResult, TmuxTarget } from "../../shared/host-op.js";

////////////////////////////////
//  Interfaces & Types

/** The tmux primitives the runner orchestrates (injected so it is unit-testable). */
export interface TmuxOps {
	peekPane: (target: TmuxTarget) => Promise<HostPeekResult>;
	sendText: (target: TmuxTarget, text: string, submit?: boolean) => Promise<void>;
	sendKey: (target: TmuxTarget, key: string) => Promise<void>;
	createSession: (target: TmuxTarget, workdirHint?: string, resumeSessionId?: string) => Promise<void>;
	reloadPlugins: (target: TmuxTarget) => Promise<void>;
	killSession: (target: TmuxTarget) => Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

// Server-side cadence floor: a peek whose pane was captured within this window returns the
// just-captured frame instead of spawning another docker exec, so the host's capture rate is
// bounded regardless of how fast the console polls.
const MIN_PEEK_INTERVAL_MS = 300;
// Cap concurrent captures so a burst across many targets cannot spawn unbounded docker execs
// (single-flight already collapses repeats of one target; this bounds distinct ones).
const MAX_CONCURRENT_PEEKS = 6;
// A completed send is replayable for this long, so a re-relayed identical op (relay timeout or
// gateway restart) returns the cached ack instead of re-injecting keys.
const SEND_DEDUP_TTL_MS = 60_000;

const targetKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

/**
 * Executes a host op against tmux with the load + idempotency controls the audit requires:
 *  - peek: single-flight + a short cadence-floor cache + a concurrency cap;
 *  - send: dedup by `dedupKey` so a re-relayed op replays the ack instead of re-injecting.
 * Returns the raw result object; the caller frames it onto the host_op_reply.
 */
export function createHostOpRunner(ops: TmuxOps, opts: { minPeekIntervalMs?: number; now?: () => number } = {}) {
	const minPeekIntervalMs = opts.minPeekIntervalMs ?? MIN_PEEK_INTERVAL_MS;
	const now = opts.now ?? (() => Date.now());
	const inflightPeeks = new Map<string, Promise<HostPeekResult>>();
	const lastCapture = new Map<string, { at: number; result: HostPeekResult }>();
	const inflightSends = new Map<string, Promise<unknown>>();
	const sentCache = new Map<string, { at: number; result: unknown }>();

	// A minimal async semaphore bounding concurrent captures.
	let activePeeks = 0;
	const peekWaiters: Array<() => void> = [];
	async function withPeekSlot<T>(fn: () => Promise<T>): Promise<T> {
		if (activePeeks >= MAX_CONCURRENT_PEEKS) await new Promise<void>((r) => peekWaiters.push(r));
		activePeeks++;
		try {
			return await fn();
		} finally {
			activePeeks--;
			peekWaiters.shift()?.();
		}
	}

	async function runPeek(target: TmuxTarget): Promise<HostPeekResult> {
		const key = targetKey(target);
		const cached = lastCapture.get(key);
		if (cached && now() - cached.at < minPeekIntervalMs) return cached.result;
		let capture = inflightPeeks.get(key);
		if (!capture) {
			capture = withPeekSlot(() => ops.peekPane(target));
			inflightPeeks.set(key, capture);
			// `.catch` before `.finally` so the cleanup-chain promise resolves: a rejecting peek is
			// still surfaced via the `await capture` below (the caller gets the error), but this
			// derived promise must not be left unhandled or it crashes the process.
			void capture.catch(() => {}).finally(() => inflightPeeks.delete(key));
		}
		const result = await capture;
		lastCapture.set(key, { at: now(), result });
		// Drop captures past the cadence floor (never reused after that) so a user-varying session
		// segment cannot grow the map without bound. Mirrors the sentCache cleanup above.
		for (const [k, v] of lastCapture) if (now() - v.at >= minPeekIntervalMs) lastCapture.delete(k);
		return result;
	}

	// Idempotency for a mutating op: a re-relayed op with the same dedupKey replays the cached ack
	// instead of re-running the side effect (a re-injected keystroke, a second session, a second
	// reload). Without a dedupKey the op runs every time. `result` is the ack to cache and return.
	async function runDeduped(
		dedupKey: string | undefined,
		exec: () => Promise<void>,
		result: unknown,
	): Promise<unknown> {
		if (!dedupKey) {
			await exec();
			return result;
		}
		const at = now();
		const prior = sentCache.get(dedupKey);
		if (prior && at - prior.at < SEND_DEDUP_TTL_MS) return prior.result;
		let inflight = inflightSends.get(dedupKey);
		if (!inflight) {
			inflight = exec().then(() => {
				sentCache.set(dedupKey, { at: now(), result });
				// Drop expired dedup entries so the map cannot grow without bound.
				for (const [k, v] of sentCache) if (now() - v.at >= SEND_DEDUP_TTL_MS) sentCache.delete(k);
				return result;
			});
			inflightSends.set(dedupKey, inflight);
			void inflight.catch(() => {}).finally(() => inflightSends.delete(dedupKey));
		}
		return inflight;
	}

	function runSend(op: Extract<HostOp, { kind: "sendText" | "sendKey" }>): Promise<unknown> {
		const exec = () =>
			op.kind === "sendText" ? ops.sendText(op.target, op.text, op.submit) : ops.sendKey(op.target, op.key);
		return runDeduped(op.dedupKey, exec, { sent: true });
	}

	async function run(op: HostOp): Promise<unknown> {
		if (op.kind === "peek") return runPeek(op.target);
		if (op.kind === "sendText" || op.kind === "sendKey") return runSend(op);
		if (op.kind === "createSession")
			return runDeduped(op.dedupKey, () => ops.createSession(op.target, op.workdirHint, op.resumeSessionId), {
				created: true,
			});
		if (op.kind === "reloadPlugins")
			return runDeduped(op.dedupKey, () => ops.reloadPlugins(op.target), { initiated: true });
		if (op.kind === "killSession")
			return runDeduped(op.dedupKey, () => ops.killSession(op.target), { killed: true });
		throw new Error("unknown host op");
	}

	return { run };
}
