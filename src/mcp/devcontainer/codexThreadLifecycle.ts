// A thread's life after the App Server loads it: requests queue per thread, a terminal arriving
// during `turn/start` is buffered until its turn id is known, and a settled turn parks the thread.

import { CodexAppServerThreadReadResultSchema, CodexAppServerTurnStartResultSchema } from "../../shared/codex-agent.js";
import type { AppServerFailure } from "./codexAppServer.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";
import { outcomeFromRead } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

export type ThreadPhase =
	/** Reached by name only, so not known to be loaded: its first activation resumes it. */
	| { phase: "unloaded" }
	/** Loaded with no turn of ours: freshly started, or resumed and refused a turn. */
	| { phase: "idle" }
	| { phase: "active"; turnId: string; epoch: number }
	| { phase: "parking"; epoch: number }
	| { phase: "parked"; epoch: number }
	| { phase: "disposed" }
	| { phase: "poisoned"; reason: PoisonReason };

/** Why a generation is not trusted again: a request whose fate is unknown, or a park that gave up. */
export type PoisonReason = { kind: "failure"; failure: AppServerFailure } | { kind: "exhausted"; attempts: number };

export interface LifecycleDeps {
	request(method: string, params: unknown): Promise<unknown>;
	/** The transport's own failure, or null for anything else. */
	classify(error: unknown): AppServerFailure | null;
	/** Published and retained BEFORE the thread is unloaded; once per turn. */
	onTerminal(threadId: string, turnId: string, terminal: TerminalOutcome): void;
	/** The consumer retires the generation; nothing on it is activated again. */
	onPoisoned(threadId: string, reason: PoisonReason): void;
}

/** What a read says about a thread as a whole, three-valued like `ReadOutcome`. */
export type ThreadInspection =
	| { known: "empty" }
	| { known: "running"; turnId: string }
	| { known: "settled"; turnId: string; outcome: TerminalOutcome }
	| { known: "unknown" };

interface ThreadRecord {
	state: ThreadPhase;
	queue: Promise<unknown>;
	/** Advanced by every activation, so a retry scheduled for an earlier life of the thread drops itself. */
	epoch: number;
	/** A `turn/start` whose id is not known yet, and the terminals that beat its response. */
	pendingStart: boolean;
	buffered: Map<string, TerminalOutcome>;
	/** Turns whose terminal already left through `onTerminal`; one entry per settled turn of this thread. */
	published: Set<string>;
	/** Archive refusals since the last activation; exhausted, the generation is poisoned. */
	parkAttempts: number;
	retry?: ReturnType<typeof setTimeout>;
}

////////////////////////////////
//  Constants

/** Refusals in a row before a park gives up on the generation. */
export const PARK_ATTEMPTS = 3;

/** Between the two reads that must both prove zero turns before a thread is deleted. */
export const DISPOSE_QUIET_MS = 250;

/** Before a park is retried after a refusal that was neither a no-rollout nor an adoption. */
export const PARK_RETRY_MS = 1_000;

////////////////////////////////
//  Class

export class ThreadLifecycle {
	private readonly threads = new Map<string, ThreadRecord>();
	/** Each quiet-interval timer with the continuation it holds, released on close rather than left hanging. */
	private readonly pauses = new Map<ReturnType<typeof setTimeout>, () => void>();
	private closed = false;

	constructor(private readonly deps: LifecycleDeps) {}

	stateOf(threadId: string): ThreadPhase | undefined {
		return this.threads.get(threadId)?.state;
	}

	/** Every thread the server still holds loaded on our account; a parking one is loaded until the archive lands. */
	loaded(): string[] {
		return [...this.threads]
			.filter(([, record]) => ["idle", "active", "parking"].includes(record.state.phase))
			.map(([threadId]) => threadId);
	}

	/**
	 * A thread the server just started for this client: loaded, with no turn yet.
	 *
	 * The reply is authoritative, so an id this client already knew is a new thread and its record is
	 * replaced. The old record's retry is cancelled first, or it would park the new one.
	 */
	started(threadId: string): void {
		const previous = this.threads.get(threadId);
		if (previous) this.cancelRetry(previous);
		this.threads.set(threadId, { ...this.fresh(), state: { phase: "idle" } });
	}

	/** Ensure a record exists, including for a thread this client never started. */
	track(threadId: string): void {
		if (!this.threads.has(threadId)) this.threads.set(threadId, this.fresh());
	}

	/** Loads a parked thread, unarchiving first if the resume is refused; a loaded one is left as it is. */
	activate(threadId: string): Promise<void> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			await this.load(threadId, record);
		});
	}

	/** Start a turn, loading the thread first; a buffered terminal for the new turn settles at once. */
	startTurn(threadId: string, params: unknown): Promise<string> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			await this.load(threadId, record);
			record.pendingStart = true;
			let turnId: string;
			try {
				turnId = await this.mutate(
					threadId,
					record,
					"turn/start",
					params,
					(result) => CodexAppServerTurnStartResultSchema.parse(result).turn.id,
				);
			} catch (error) {
				// The start failed, so no turn of ours owns them; they are still terminals nobody else will report.
				record.pendingStart = false;
				await this.drain(threadId, record);
				throw error;
			}
			record.pendingStart = false;
			record.epoch += 1;
			record.state = { phase: "active", turnId, epoch: record.epoch };
			record.parkAttempts = 0;
			await this.drain(threadId, record);
			return turnId;
		});
	}

	/** Refused only for what this client knows is wrong: another turn active, or a thread that ended. */
	steerTurn(threadId: string, turnId: string, params: unknown): Promise<unknown> {
		return this.control(threadId, turnId, "turn/steer", params);
	}

	interruptTurn(threadId: string, turnId: string, params: unknown): Promise<unknown> {
		return this.control(threadId, turnId, "turn/interrupt", params);
	}

	/** A read of the thread, in its queue like every other request, so it never crosses one in flight. */
	read(threadId: string, params: unknown): Promise<unknown> {
		this.track(threadId);
		return this.run(threadId, (record) => {
			this.refuseEnded(threadId, record);
			return this.mutate(threadId, record, "thread/read", params, (result) => result);
		});
	}

	/**
	 * The one entry for a terminal, from whichever observer saw it. Published once whatever turn it
	 * names; the thread parks only when that turn is its own, or when it had no turn of its own.
	 */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void> {
		// A terminal is the one report of a turn, so a thread only heard of here is tracked, never dropped.
		this.track(threadId);
		const record = this.threads.get(threadId) as ThreadRecord;
		// Buffered outside the queue: the start holding it cannot release it until it has its id.
		if (record.pendingStart) {
			record.buffered.set(turnId, terminal);
			return Promise.resolve();
		}
		return this.run(threadId, (current) => this.accept(threadId, current, turnId, terminal));
	}

	/**
	 * Read the thread and take whatever it holds: a running turn becomes ours, a settled one is
	 * settled, and two reads proving nothing delete it. An unknown read leaves it as it is.
	 */
	adoptOrDispose(threadId: string): Promise<ThreadInspection> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			const first = await this.inspect(threadId, record);
			if (first.known === "running") {
				this.cancelRetry(record);
				record.epoch += 1;
				record.state = { phase: "active", turnId: first.turnId, epoch: record.epoch };
				return first;
			}
			if (first.known === "settled") {
				// The read is authoritative: no turn is running, whatever this client believed.
				if (record.state.phase === "active") record.state = { phase: "idle" };
				await this.accept(threadId, record, first.turnId, first.outcome);
				return first;
			}
			if (first.known === "unknown") return first;
			await this.pause(DISPOSE_QUIET_MS);
			const second = await this.inspect(threadId, record);
			if (second.known !== "empty") return second;
			await this.mutate(threadId, record, "thread/delete", { threadId }, () => undefined);
			record.state = { phase: "disposed" };
			return second;
		});
	}

	/** Cancels every timer; a paused operation continues at once into the closed transport, nothing retries. */
	close(): void {
		this.closed = true;
		for (const [timer, release] of this.pauses) {
			clearTimeout(timer);
			release();
		}
		this.pauses.clear();
		for (const record of this.threads.values()) this.cancelRetry(record);
	}

	private fresh(): ThreadRecord {
		return {
			state: { phase: "unloaded" },
			queue: Promise.resolve(),
			epoch: 0,
			pendingStart: false,
			buffered: new Map(),
			published: new Set(),
			parkAttempts: 0,
		};
	}

	/** One operation at a time per thread, whatever the caller. */
	private run<T>(threadId: string, operation: (record: ThreadRecord) => Promise<T>): Promise<T> {
		const record = this.threads.get(threadId) ?? this.fresh();
		this.threads.set(threadId, record);
		const next = record.queue.then(() => operation(record));
		record.queue = next.catch(() => undefined);
		return next;
	}

	/** Read after a request that may have moved the state, past the narrowing the compiler keeps across it. */
	private phase(record: ThreadRecord): ThreadPhase["phase"] {
		return record.state.phase;
	}

	private refuseEnded(threadId: string, record: ThreadRecord): void {
		if (record.state.phase === "disposed") throw new Error(`thread ${threadId} was disposed`);
		if (record.state.phase === "poisoned") throw new Error(`thread ${threadId} is on a poisoned generation`);
	}

	private control(threadId: string, turnId: string, method: string, params: unknown): Promise<unknown> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			if (record.state.phase === "active" && record.state.turnId !== turnId) {
				throw new Error(`no active turn ${turnId} on thread ${threadId}`);
			}
			return this.deps.request(method, params);
		});
	}

	/** Leaves the thread loaded and `idle`: resuming what is parked or unloaded, dropping a parking retry. */
	private async load(threadId: string, record: ThreadRecord): Promise<void> {
		if (record.state.phase === "idle" || record.state.phase === "active") return;
		this.cancelRetry(record);
		if (record.state.phase !== "parking") await this.resume(threadId, record);
		record.epoch += 1;
		record.state = { phase: "idle" };
	}

	private async resume(threadId: string, record: ThreadRecord): Promise<void> {
		try {
			await this.mutate(threadId, record, "thread/resume", { threadId }, () => undefined);
			return;
		} catch (error) {
			if (this.deps.classify(error)?.kind !== "refused") throw error;
			try {
				await this.mutate(threadId, record, "thread/unarchive", { threadId }, () => undefined);
			} catch (unarchive) {
				const refused = this.deps.classify(unarchive);
				if (refused?.kind === "refused") throw error;
				throw unarchive;
			}
			await this.mutate(threadId, record, "thread/resume", { threadId }, () => undefined);
		}
	}

	/** Every terminal held while a start had no id yet; none of them owns the thread. */
	private async drain(threadId: string, record: ThreadRecord): Promise<void> {
		const held = [...record.buffered];
		record.buffered.clear();
		for (const [id, terminal] of held) await this.accept(threadId, record, id, terminal);
	}

	/** Publish once, then park when the turn is the thread's own or the thread had none. */
	private async accept(
		threadId: string,
		record: ThreadRecord,
		turnId: string,
		terminal: TerminalOutcome,
	): Promise<void> {
		if (!record.published.has(turnId)) {
			record.published.add(turnId);
			this.deps.onTerminal(threadId, turnId, terminal);
		}
		// A terminal proves the thread was loaded, so one reached by name parks like an idle one.
		const own = record.state.phase === "active" && record.state.turnId === turnId;
		if (!own && record.state.phase !== "idle" && record.state.phase !== "unloaded") return;
		record.state = { phase: "parking", epoch: record.epoch };
		await this.park(threadId, record, record.epoch);
	}

	private async park(threadId: string, record: ThreadRecord, epoch: number): Promise<void> {
		if (record.state.phase !== "parking" || record.state.epoch !== epoch) return;
		try {
			await this.mutate(threadId, record, "thread/archive", { threadId }, () => undefined);
			record.state = { phase: "parked", epoch };
			record.parkAttempts = 0;
			return;
		} catch (error) {
			// Poisoned by the request itself: the caller learns it the way it would from any request.
			const phase = this.phase(record);
			if (phase === "poisoned") throw error;
			if (phase !== "parking") return;
			if (this.deps.classify(error)?.kind !== "refused") throw error;
		}
		// Refused: no rollout, or something the read below tells apart from it.
		const first = await this.inspect(threadId, record);
		if (first.known === "running") {
			record.epoch += 1;
			record.state = { phase: "active", turnId: first.turnId, epoch: record.epoch };
			return;
		}
		if (first.known === "empty") {
			await this.pause(DISPOSE_QUIET_MS);
			const second = await this.inspect(threadId, record);
			if (second.known === "empty") {
				try {
					await this.mutate(threadId, record, "thread/delete", { threadId }, () => undefined);
					record.state = { phase: "disposed" };
					return;
				} catch (error) {
					// A refused delete is another way this park did not happen, and is budgeted like one.
					if (this.deps.classify(error)?.kind !== "refused") throw error;
				}
			}
		}
		record.parkAttempts += 1;
		if (record.parkAttempts >= PARK_ATTEMPTS) {
			this.poison(threadId, record, { kind: "exhausted", attempts: record.parkAttempts });
			return;
		}
		this.retryLater(threadId, record, epoch);
	}

	/** A desired state outside the queue's lock; an activation drops it. */
	private retryLater(threadId: string, record: ThreadRecord, epoch: number): void {
		if (this.closed) return;
		this.cancelRetry(record);
		record.retry = setTimeout(() => {
			record.retry = undefined;
			void this.run(threadId, (current) => this.park(threadId, current, epoch)).catch(() => undefined);
		}, PARK_RETRY_MS);
	}

	private cancelRetry(record: ThreadRecord): void {
		if (record.retry === undefined) return;
		clearTimeout(record.retry);
		record.retry = undefined;
	}

	private async inspect(threadId: string, record: ThreadRecord): Promise<ThreadInspection> {
		const result = await this.mutate(
			threadId,
			record,
			"thread/read",
			{ threadId, includeTurns: true },
			(value) => value,
		);
		return inspectRead(result, threadId);
	}

	/** A lifecycle request. A timeout or an unreadable reply poisons the thread's generation; a refusal throws. */
	private async mutate<T>(
		threadId: string,
		record: ThreadRecord,
		method: string,
		params: unknown,
		read: (result: unknown) => T,
	): Promise<T> {
		// A record the map no longer holds belongs to a thread the server replaced; its requests would
		// reach the new one, so an operation already in flight stops here rather than at the wire.
		if (this.threads.get(threadId) !== record) throw new Error(`thread ${threadId} was replaced`);
		try {
			return read(await this.deps.request(method, params));
		} catch (error) {
			const failure = this.deps.classify(error);
			if (failure && (failure.kind === "timeout" || failure.kind === "unreadable")) {
				this.poison(threadId, record, { kind: "failure", failure });
			}
			throw error;
		}
	}

	private poison(threadId: string, record: ThreadRecord, reason: PoisonReason): void {
		if (record.state.phase === "poisoned") return;
		this.cancelRetry(record);
		record.state = { phase: "poisoned", reason };
		this.deps.onPoisoned(threadId, reason);
	}

	private pause(ms: number): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pauses.delete(timer);
				resolve();
			}, ms);
			this.pauses.set(timer, resolve);
		});
	}
}

////////////////////////////////
//  Functions & Helpers

/** The thread as a whole: the running turn if any, else the last settled one, else nothing. */
export function inspectRead(result: unknown, threadId: string): ThreadInspection {
	const parsed = CodexAppServerThreadReadResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.thread.id !== threadId) return { known: "unknown" };
	const turns = parsed.data.thread.turns;
	if (turns.length === 0) return { known: "empty" };
	const running = turns.find((turn) => turn.status === "inProgress");
	if (running) return { known: "running", turnId: running.id };
	const last = turns[turns.length - 1]!;
	const outcome = outcomeFromRead(result, threadId, last.id);
	if (outcome.known !== "settled") return { known: "unknown" };
	return { known: "settled", turnId: last.id, outcome: outcome.outcome };
}
