import type { HostListDirsResult, HostOp, HostPeekResult, TmuxTarget } from "../../shared/host-op.js";

export interface TmuxOps {
	peekPane: (target: TmuxTarget, resize?: boolean) => Promise<HostPeekResult>;
	sendText: (target: TmuxTarget, text: string, submit?: boolean) => Promise<void>;
	sendKey: (target: TmuxTarget, key: string) => Promise<void>;
	createSession: (
		target: TmuxTarget,
		workdirHint?: string,
		resumeSessionId?: string,
		sessionToken?: string,
	) => Promise<unknown>;
	reloadPlugins: (target: TmuxTarget) => Promise<unknown>;
	killSession: (target: TmuxTarget) => Promise<void>;
	listDirs: (path: string, spawn?: string) => Promise<HostListDirsResult>;
}

export type PeekPriority = "interactive" | "derive";

const MIN_PEEK_INTERVAL_MS = 300;
const MAX_CONCURRENT_PEEKS = 6;
const SEND_DEDUP_TTL_MS = 60_000;

const targetKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

export function createHostOpRunner(ops: TmuxOps, opts: { minPeekIntervalMs?: number; now?: () => number } = {}) {
	const minPeekIntervalMs = opts.minPeekIntervalMs ?? MIN_PEEK_INTERVAL_MS;
	const now = opts.now ?? (() => Date.now());
	const inflightPeeks = new Map<string, Promise<HostPeekResult>>();
	const lastCapture = new Map<string, { at: number; result: HostPeekResult }>();
	const inflightSends = new Map<string, Promise<unknown>>();
	const sentCache = new Map<string, { at: number; result: unknown }>();

	let activePeeks = 0;
	const interactiveWaiters: Array<() => void> = [];
	const deriveWaiters: Array<() => void> = [];
	// Interactive peeks preempt derive peeks. Each lane remains FIFO.
	async function withPeekSlot<T>(priority: PeekPriority, fn: () => Promise<T>): Promise<T> {
		if (activePeeks >= MAX_CONCURRENT_PEEKS) {
			const queue = priority === "interactive" ? interactiveWaiters : deriveWaiters;
			await new Promise<void>((r) => queue.push(r));
		}
		activePeeks++;
		try {
			return await fn();
		} finally {
			activePeeks--;
			(interactiveWaiters.shift() ?? deriveWaiters.shift())?.();
		}
	}

	async function runPeek(
		target: TmuxTarget,
		peekOpts: { resize?: boolean; priority?: PeekPriority } = {},
	): Promise<HostPeekResult> {
		const { resize = true, priority = "interactive" } = peekOpts;
		const key = targetKey(target);
		const cached = lastCapture.get(key);
		if (cached && now() - cached.at < minPeekIntervalMs) return cached.result;
		let capture = inflightPeeks.get(key);
		if (!capture) {
			// Joiners use the initiator's resize choice.
			capture = withPeekSlot(priority, () => ops.peekPane(target, resize));
			inflightPeeks.set(key, capture);
			// Attach catch before finally so rejection is observed.
			void capture.catch(() => {}).finally(() => inflightPeeks.delete(key));
		}
		const result = await capture;
		lastCapture.set(key, { at: now(), result });
		for (const [k, v] of lastCapture) if (now() - v.at >= minPeekIntervalMs) lastCapture.delete(k);
		return result;
	}

	async function runDeduped(
		dedupKey: string | undefined,
		exec: () => Promise<unknown>,
		result: unknown,
	): Promise<unknown> {
		// Missing dedup keys intentionally execute every request.
		if (!dedupKey) {
			return (await exec()) ?? result;
		}
		const at = now();
		const prior = sentCache.get(dedupKey);
		if (prior && at - prior.at < SEND_DEDUP_TTL_MS) return prior.result;
		let inflight = inflightSends.get(dedupKey);
		if (!inflight) {
			inflight = exec().then((value) => {
				const settled = value ?? result;
				sentCache.set(dedupKey, { at: now(), result: settled });
				for (const [k, v] of sentCache) if (now() - v.at >= SEND_DEDUP_TTL_MS) sentCache.delete(k);
				return settled;
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
		if (op.kind === "listDirs") return ops.listDirs(op.path, op.spawn);
		if (op.kind === "createSession")
			return runDeduped(
				op.dedupKey,
				() => ops.createSession(op.target, op.workdirHint, op.resumeSessionId, op.sessionToken),
				{ created: true },
			);
		if (op.kind === "reloadPlugins")
			return runDeduped(op.dedupKey, () => ops.reloadPlugins(op.target), { initiated: true });
		if (op.kind === "killSession")
			return runDeduped(op.dedupKey, () => ops.killSession(op.target), { killed: true });
		const unhandled: never = op;
		throw new Error(`unknown host op ${JSON.stringify(unhandled)}`);
	}

	return { run, peek: runPeek };
}
