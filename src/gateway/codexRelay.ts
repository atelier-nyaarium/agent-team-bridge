import type { Ambient } from "../shared/ambient.js";
import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	type CodexPersistedAgent,
} from "../shared/codex-agent.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { CodexAgentService } from "./codexAgentService.js";
import type { CodexApplication } from "./codexAgentTypes.js";

/** Distributes over command variants so each payload keeps its discriminant. */
type CodexCommandRequest = CodexDaemonCommand extends infer Command
	? Command extends CodexDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

export interface CodexRelayDeps {
	service: CodexAgentService;
	sessionStore: SessionStore;
	/** Unsent commands are retried by reconnect reconciliation. */
	sendToHost(message: Record<string, unknown>): boolean;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
}

/** Highest decided stays separate so clearing a hold releases later decisions. */
interface StreamProgress {
	committedThrough: number;
	highestDecided: number;
	/** Undecided event IDs mapped to their agent for targeted reconciliation. */
	undecided: Map<number, string>;
}

const MAX_DEFERRED_PER_AGENT = 128;

export const RECONCILE_GUARD_MS = 300_000;

// The separator prevents composite-key collisions.
function streamKey(message: { daemonInstanceId: string; targetId: string; generation: number }): string {
	return `${message.daemonInstanceId} ${message.targetId} ${message.generation}`;
}

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

function isAskable(agent: CodexPersistedAgent): boolean {
	return agent.threadId !== undefined && agent.resolvedTarget !== undefined;
}

function needsReconciliation(agent: CodexPersistedAgent): boolean {
	return isAskable(agent) && (agent.agentState === "working" || agent.agentState === "recovering");
}

export class CodexRelay {
	private readonly sections = new Map<string, Promise<unknown>>();
	private readonly streams = new Map<string, StreamProgress>();
	private readonly listeners = new Map<string, Set<() => void>>();
	// Timestamps bound reconciliation suppression.
	private readonly reconciling = new Map<string, number>();
	private readonly deferred = new Map<string, Array<CodexDaemonEvent | CodexDaemonReceipt>>();

	constructor(private readonly deps: CodexRelayDeps) {}

	dispatch(command: CodexCommandRequest): boolean {
		const message = { type: "codex_command", requestId: this.deps.ambient.newId(), ...command };
		if (!CodexDaemonCommandSchema.safeParse(message).success) return false;
		return this.deps.sendToHost(message);
	}

	reconcileStale(owner: SessionRecord): void {
		const ownerKey = this.deps.sessionStore.teamOf(owner);
		for (const agent of this.deps.sessionStore.listCodexAgents(owner)) {
			if (needsReconciliation(agent)) this.requestReconciliation(ownerKey, agent);
		}
	}

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

	waitFor(ownerKey: string, agentId: string, settled: () => boolean, deadlineMs: number): Promise<boolean> {
		if (settled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				this.deps.ambient.clearTimer(timer);
				unsubscribe();
				resolve(value);
			};
			const timer = this.deps.ambient.setTimer(() => finish(false), Math.max(0, deadlineMs - this.now()));
			const unsubscribe = this.onAgentChange(ownerKey, agentId, () => {
				if (settled()) finish(true);
			});
		});
	}

	private onHello(raw: Record<string, unknown>): void {
		const hello = CodexDaemonHelloSchema.safeParse(raw);
		if (!hello.success) return;
		// A hello invalidates outstanding reconciliation guards.
		this.reconciling.clear();
		// The gateway owns the reconciliation candidate list.
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.deps.sessionStore.listCodexAgents(owner)) {
				// A held frame requires reconciliation even after the record becomes idle.
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
		// Any reconciliation answer clears its guard; other refusals carry operationId.
		if (receipt.kind === "rejected" && receipt.operationId !== undefined) return;
		if (receipt.kind !== "reconciled" && receipt.kind !== "rejected") return;
		if (!this.reconciling.delete(agentKey(receipt.ownerKey, receipt.agentId))) return;
		if (application.disposition !== "applied") return;
		this.drainDeferred(receipt.ownerKey, receipt.agentId);
	}

	private reduceEvent(event: CodexDaemonEvent): void {
		this.settle(event, this.deps.service.applyEvent(event, this.now()));
	}

	private settle(message: CodexDaemonEvent | CodexDaemonReceipt, application: CodexApplication): void {
		// Failed records always hold; reconciliation holds only askable agents.
		const repairable =
			application.disposition === "failed" ||
			(application.disposition === "reconcile" && isAskable(application.agent));
		if (repairable) {
			this.defer(message);
			if (application.disposition === "reconcile") {
				this.requestReconciliation(message.ownerKey, application.agent);
			}
		}
		// Refusals have no stream generation to acknowledge.
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
		// Advance the watermark only after the acknowledgement is sent.
		if (sent) progress.committedThrough = through;
	}

	private defer(message: CodexDaemonEvent | CodexDaemonReceipt): void {
		const key = agentKey(message.ownerKey, message.agentId);
		const held = this.deferred.get(key) ?? [];
		// Reconnect replays require deduplication.
		if (held.some((existing) => existing.type === message.type && existing.eventId === message.eventId)) return;
		held.push(message);
		this.deferred.set(key, held);
		while (held.length > MAX_DEFERRED_PER_AGENT) {
			// Drop activity before receipts when the deferred queue is full.
			const index = held.findIndex((candidate) => candidate.kind === "activity");
			held.splice(index >= 0 ? index : 0, 1);
		}
	}

	private drainDeferred(ownerKey: string, agentId: string): void {
		const key = agentKey(ownerKey, agentId);
		const held = this.deferred.get(key);
		this.deferred.delete(key);
		// Reconciliation supersedes all undecided frames for that agent.
		for (const [streamId, progress] of this.streams) {
			for (const [eventId, owner] of progress.undecided) {
				if (owner === key) progress.undecided.delete(eventId);
			}
			this.releaseStream(streamId, progress);
		}
		if (!held?.length) return;
		// Replay frames in event order.
		for (const message of [...held].sort((left, right) => left.eventId - right.eventId)) {
			if (message.type === "codex_event") this.reduceEvent(message);
			else this.reduceReceipt(message);
		}
	}

	private releaseStream(streamId: string, progress: StreamProgress): void {
		const [daemonInstanceId, targetId, generation] = streamId.split(" ");
		if (!daemonInstanceId || !targetId || generation === undefined) return;
		this.acknowledge({ daemonInstanceId, targetId, generation: Number(generation) }, progress);
	}

	private requestReconciliation(ownerKey: string, agent: CodexPersistedAgent): void {
		if (!agent.threadId || !agent.resolvedTarget) return;
		const key = agentKey(ownerKey, agent.agentId);
		// Allow one time-bounded reconciliation request per agent.
		const askedAt = this.reconciling.get(key);
		if (askedAt !== undefined && this.now() - askedAt < RECONCILE_GUARD_MS) return;
		this.reconciling.set(key, this.now());
		const sent = this.dispatch({
			kind: "reconcile",
			ownerKey,
			agentId: agent.agentId,
			target: agent.resolvedTarget,
			threadId: agent.threadId,
			turnId: agent.activeTurnId,
		});
		// Unsent requests must not hold the guard.
		if (!sent) this.reconciling.delete(key);
	}

	/** Serialize one reducer step per agent. */
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
		return this.deps.ambient.now();
	}
}
