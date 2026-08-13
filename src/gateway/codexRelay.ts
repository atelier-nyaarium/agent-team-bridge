import crypto from "node:crypto";
import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	type CodexPersistedAgent,
} from "../shared/codex-thinking.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { CodexAgentService, CodexApplication } from "./codexAgentService.js";

////////////////////////////////
//  Interfaces & Types

/** A command minus the fields the relay itself owns. Distributed over the union deliberately: a
 * plain `Omit` collapses the four command shapes into their shared fields and loses the discriminant
 * each one's own payload hangs off. */
type CodexCommandRequest = CodexDaemonCommand extends infer Command
	? Command extends CodexDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

export interface CodexRelayDeps {
	service: CodexAgentService;
	sessionStore: SessionStore;
	/** False when no authenticated host socket is attached. A command that cannot be sent is not
	 * queued here: the caller reports it, and reconnect reconciliation recovers the record. */
	sendToHost(message: Record<string, unknown>): boolean;
	now?(): number;
}

/** One generation's reliable stream. `highestDecided` is separate from `committedThrough` because
 * clearing a block must release every decided event above it, not just the one that cleared it. */
interface StreamProgress {
	committedThrough: number;
	highestDecided: number;
	/**
	 * Event IDs this gateway could not decide, each mapped to the agent it was about. Nothing at or
	 * above the lowest may be acknowledged, since acknowledging retires the daemon's only copy.
	 *
	 * Keyed by agent because a stream carries every agent on one target: a completed reconciliation
	 * supersedes that agent's undecided frames and only that agent's, and without the attribution the
	 * release would either strand the stream or free somebody else's.
	 */
	undecided: Map<number, string>;
}

/** How many frames one agent may hold pending reconciliation. A stream this far out of step is being
 * repaired by reconciliation rather than by patience. */
const MAX_DEFERRED_PER_AGENT = 128;

////////////////////////////////
//  Functions & Helpers

// Both keys join fields with a separator that cannot occur inside any of them. Concatenating bare
// would let one pair collide with another that merely splits at a different point.
function streamKey(message: { daemonInstanceId: string; targetId: string; generation: number }): string {
	return `${message.daemonInstanceId} ${message.targetId} ${message.generation}`;
}

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

/** Whether there is anything to ask the daemon ABOUT. A record with no thread names nothing a
 * reconcile command could carry, so no answer can ever arrive for it. */
function isAskable(agent: CodexPersistedAgent): boolean {
	return agent.threadId !== undefined && agent.resolvedTarget !== undefined;
}

/** A record whose owner still believes work is outstanding. These are what the gateway asks about on
 * reconnect; an idle agent has nothing a restarted daemon could contradict. */
function needsReconciliation(agent: CodexPersistedAgent): boolean {
	return isAskable(agent) && (agent.agentState === "working" || agent.agentState === "recovering");
}

////////////////////////////////
//  Class

/**
 * The gateway's Codex relay: one serialized reducer per agent, and the acknowledgement the daemon
 * prunes its outbox against.
 *
 * The section is held only across the decide-and-persist step. Daemon I/O and a caller's wait happen
 * outside it, and the catalog's own revision check is what makes a decision taken against a stale
 * read fail rather than overwrite.
 */
export class CodexRelay {
	private readonly sections = new Map<string, Promise<unknown>>();
	private readonly streams = new Map<string, StreamProgress>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly reconciling = new Set<string>();
	private readonly deferred = new Map<string, Array<CodexDaemonEvent | CodexDaemonReceipt>>();

	constructor(private readonly deps: CodexRelayDeps) {}

	/** Send one command to the daemon. Returns false when no host is attached. */
	dispatch(command: CodexCommandRequest): boolean {
		const message = { type: "codex_command", requestId: crypto.randomUUID(), ...command };
		if (!CodexDaemonCommandSchema.safeParse(message).success) return false;
		return this.deps.sendToHost(message);
	}

	/**
	 * Ask about every record of one owner that still believes work is outstanding.
	 *
	 * The second reconciliation trigger beside a daemon reconnect. Without it, an owner whose daemon
	 * never disconnects keeps being told "could not confirm" forever, because a reconnect is the only
	 * other thing that ever asks. Cheap and idempotent: the per-agent guard collapses repeats.
	 */
	reconcileStale(owner: SessionRecord): void {
		const ownerKey = this.deps.sessionStore.teamOf(owner);
		for (const agent of this.deps.sessionStore.listCodexAgents(owner)) {
			if (needsReconciliation(agent)) this.requestReconciliation(ownerKey, agent);
		}
	}

	/** Every Codex frame arriving on the authenticated host socket. */
	handleHostMessage(raw: Record<string, unknown>): void {
		switch (raw.type) {
			case "codex_hello":
				this.onHello(raw);
				return;
			case "codex_receipt":
				this.onReceipt(raw);
				return;
			case "codex_event":
				this.onEvent(raw);
				return;
			default:
				return;
		}
	}

	/** Wake on the next committed change to one agent. The caller owns its own deadline; this only
	 * says that something moved. */
	onAgentChange(ownerKey: string, agentId: string, listener: () => void): () => void {
		const key = agentKey(ownerKey, agentId);
		const set = this.listeners.get(key) ?? new Set();
		set.add(listener);
		this.listeners.set(key, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(key);
		};
	}

	/**
	 * Block until `settled` says the agent has reached what the caller is waiting for, or the deadline
	 * passes. Resolves true when settled, false on expiry.
	 *
	 * `settled` is re-read on every committed change and once up front, so a turn that finished before
	 * the wait began returns immediately rather than waiting out the whole budget for a change that
	 * has already happened.
	 */
	waitFor(ownerKey: string, agentId: string, settled: () => boolean, deadlineMs: number): Promise<boolean> {
		if (settled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				clearTimeout(timer);
				unsubscribe();
				resolve(value);
			};
			const timer = setTimeout(() => finish(false), Math.max(0, deadlineMs - this.now()));
			const unsubscribe = this.onAgentChange(ownerKey, agentId, () => {
				if (settled()) finish(true);
			});
		});
	}

	private onHello(raw: Record<string, unknown>): void {
		const hello = CodexDaemonHelloSchema.safeParse(raw);
		if (!hello.success) return;
		// The gateway enumerates, not the daemon: only this side knows which records an owner still
		// believes are working, and a restarted daemon knows nothing at all.
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.deps.sessionStore.listCodexAgents(owner)) {
				// A HELD frame is a reason to ask in its own right, independent of what the record now
				// says. Only a completed reconciliation releases a hold, so an agent that has since gone
				// idle would otherwise never be asked about again and its frame would cap the whole
				// target's acknowledgement for the life of the generation.
				if (needsReconciliation(agent) || this.deferred.has(agentKey(ownerKey, agent.agentId))) {
					this.requestReconciliation(ownerKey, agent);
				}
			}
		}
	}

	private onReceipt(raw: Record<string, unknown>): void {
		const parsed = CodexDaemonReceiptSchema.safeParse(raw);
		if (!parsed.success) return;
		void this.serialize(parsed.data.ownerKey, parsed.data.agentId, () => this.reduceReceipt(parsed.data));
	}

	private onEvent(raw: Record<string, unknown>): void {
		const parsed = CodexDaemonEventSchema.safeParse(raw);
		if (!parsed.success) return;
		void this.serialize(parsed.data.ownerKey, parsed.data.agentId, () => this.reduceEvent(parsed.data));
	}

	private reduceReceipt(receipt: CodexDaemonReceipt): void {
		const application = this.deps.service.applyReceipt(receipt, this.now());
		this.settle(receipt, application);
		// Cleared on ANY answer to the reconcile, not only a successful one: a refused reconcile is what
		// a target that has gone away replies with, and gating the clear on success would make the one
		// situation reconciliation exists for the one it never retries. A reconcile is the only command
		// whose refusal carries no operationId, which is what tells a refused reconcile apart from a
		// refused start, message or stop for the same agent.
		if (receipt.kind === "rejected" && receipt.operationId !== undefined) return;
		if (receipt.kind !== "reconciled" && receipt.kind !== "rejected") return;
		if (!this.reconciling.delete(agentKey(receipt.ownerKey, receipt.agentId))) return;
		if (application.disposition !== "applied") return;
		this.drainDeferred(receipt.ownerKey, receipt.agentId);
	}

	private reduceEvent(event: CodexDaemonEvent): void {
		this.settle(event, this.deps.service.applyEvent(event, this.now()));
	}

	/** Record what one message's outcome means for the daemon's outbox, then tell any waiter. */
	private settle(message: CodexDaemonEvent | CodexDaemonReceipt, application: CodexApplication): void {
		// Whether a frame may be retired is a fact about the RECORD, never about whether a socket
		// happened to be attached. Asking is a separate, best-effort action: a host that is momentarily
		// gone comes back and the next hello asks again, whereas a frame acked on its absence is gone
		// for good. A record nobody can ask about at all - no thread yet - is genuinely decided, since
		// holding it would cap the acknowledgement for every agent on that target with nothing left to
		// release it.
		// `failed` means the gateway could not build a record, which is a fact about this code and not
		// about the frame. It holds unconditionally: acknowledging it would let a reducer bug delete the
		// daemon's only copy of a terminal. `reconcile` holds too, but only when there is somebody to
		// ask - a record with no thread can never be answered about.
		const repairable =
			application.disposition === "failed" ||
			(application.disposition === "reconcile" && isAskable(application.agent));
		if (repairable) {
			this.defer(message);
			if (application.disposition === "reconcile") {
				this.requestReconciliation(message.ownerKey, application.agent);
			}
		}
		// A refusal carries no generation, so there is no stream to advance and nothing to acknowledge.
		if ("targetId" in message && "generation" in message) {
			this.advance(message, repairable ? "hold" : "decided");
		}
		if (application.disposition !== "applied") return;
		for (const listener of this.listeners.get(agentKey(message.ownerKey, message.agentId)) ?? []) listener();
	}

	private advance(
		message: {
			ownerKey: string;
			agentId: string;
			daemonInstanceId: string;
			targetId: string;
			generation: number;
			eventId: number;
		},
		outcome: "hold" | "decided",
	): void {
		const key = streamKey(message);
		const progress = this.streams.get(key) ?? {
			committedThrough: -1,
			highestDecided: -1,
			undecided: new Map<number, string>(),
		};
		this.streams.set(key, progress);
		if (outcome === "hold") {
			progress.undecided.set(message.eventId, agentKey(message.ownerKey, message.agentId));
			return;
		}
		progress.undecided.delete(message.eventId);
		progress.highestDecided = Math.max(progress.highestDecided, message.eventId);
		this.acknowledge(message, progress);
	}

	private acknowledge(
		message: { daemonInstanceId: string; targetId: string; generation: number },
		progress: StreamProgress,
	): void {
		const lowestUndecided = progress.undecided.size === 0 ? Infinity : Math.min(...progress.undecided.keys());
		const through = Math.min(progress.highestDecided, lowestUndecided - 1);
		if (through <= progress.committedThrough) return;
		const sent = this.deps.sendToHost({
			type: "codex_ack",
			daemonInstanceId: message.daemonInstanceId,
			targetId: message.targetId,
			generation: message.generation,
			throughEventId: through,
		});
		// The watermark moves only once the acknowledgement actually left. Advancing it on a failed send
		// would leave the daemon holding those receipts with nothing that ever re-sends the number:
		// their replays re-decide as duplicates and return early here on the very watermark that never
		// shipped. A busy stream hides it under the next ack; a quiet one never recovers.
		if (sent) progress.committedThrough = through;
	}

	private defer(message: CodexDaemonEvent | CodexDaemonReceipt): void {
		const key = agentKey(message.ownerKey, message.agentId);
		const held = this.deferred.get(key) ?? [];
		// The daemon replays every retained reliable frame on each reconnect, so without this the same
		// frame accumulates a copy per reconnect and the cap is reached by churn rather than by news.
		if (held.some((existing) => existing.type === message.type && existing.eventId === message.eventId)) return;
		held.push(message);
		this.deferred.set(key, held);
		while (held.length > MAX_DEFERRED_PER_AGENT) {
			// Commentary goes first: the daemon sends it best-effort anyway, so dropping one costs a line
			// of narration where dropping a receipt costs an outcome. The dropped frame stays UNDECIDED
			// either way, so the acknowledgement it holds is released by reconciliation, not by eviction.
			const index = held.findIndex((candidate) => candidate.kind === "activity");
			held.splice(index >= 0 ? index : 0, 1);
		}
	}

	private drainDeferred(ownerKey: string, agentId: string): void {
		const key = agentKey(ownerKey, agentId);
		const held = this.deferred.get(key);
		this.deferred.delete(key);
		// A completed reconciliation is the authority on this agent, so every frame still undecided for
		// it is superseded whether or not the queue still holds a copy to re-run. Releasing here is what
		// keeps an evicted frame from capping its target's acknowledgement for good.
		for (const [streamId, progress] of this.streams) {
			for (const [eventId, owner] of progress.undecided) {
				if (owner === key) progress.undecided.delete(eventId);
			}
			this.releaseStream(streamId, progress);
		}
		if (!held?.length) return;
		// Oldest first, so a terminal cannot be re-applied ahead of the activity that preceded it.
		for (const message of [...held].sort((left, right) => left.eventId - right.eventId)) {
			if (message.type === "codex_event") this.reduceEvent(message);
			else this.reduceReceipt(message);
		}
	}

	/** Send whatever acknowledgement a stream's release now permits. The stream key carries the three
	 * fields the acknowledgement needs, so a release does not have to wait for the next frame. */
	private releaseStream(streamId: string, progress: StreamProgress): void {
		const [daemonInstanceId, targetId, generation] = streamId.split(" ");
		if (!daemonInstanceId || !targetId || generation === undefined) return;
		this.acknowledge({ daemonInstanceId, targetId, generation: Number(generation) }, progress);
	}

	/** Ask the daemon what one agent actually is. Best-effort by design: the caller has already decided
	 * what to do with the frame, and a request that cannot go out now goes out on the next hello. */
	private requestReconciliation(ownerKey: string, agent: CodexPersistedAgent): void {
		if (!agent.threadId || !agent.resolvedTarget) return;
		const key = agentKey(ownerKey, agent.agentId);
		// One outstanding request per agent: every withheld event in a stalled stream would otherwise
		// ask again, and the answer to all of them is the same one message.
		if (this.reconciling.has(key)) return;
		this.reconciling.add(key);
		const sent = this.dispatch({
			kind: "reconcile",
			ownerKey,
			agentId: agent.agentId,
			target: agent.resolvedTarget,
			threadId: agent.threadId,
			turnId: agent.activeTurnId,
		});
		// A request that never left is not outstanding, so the next hello may ask again.
		if (!sent) this.reconciling.delete(key);
	}

	/** Run one reducer step with nothing else touching the same agent. */
	private serialize(ownerKey: string, agentId: string, step: () => void): Promise<void> {
		const key = agentKey(ownerKey, agentId);
		const previous = this.sections.get(key) ?? Promise.resolve();
		const next = previous
			.then(step)
			.catch((error) => console.error("[codex-relay] reducer step failed:", error))
			.finally(() => {
				if (this.sections.get(key) === next) this.sections.delete(key);
			});
		this.sections.set(key, next);
		return next;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}
