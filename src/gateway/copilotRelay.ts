import crypto from "node:crypto";
import {
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	CopilotDaemonHelloSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
} from "../shared/copilot-thinking.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { CopilotAgentService, CopilotApplication } from "./copilotAgentService.js";

type CopilotCommandRequest = CopilotDaemonCommand extends infer Command
	? Command extends CopilotDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

interface StreamProgress {
	committedThrough: number;
	highestDecided: number;
	undecided: Map<number, string>;
}

export interface CopilotRelayDeps {
	service: CopilotAgentService;
	sessionStore: SessionStore;
	sendToHost(message: Record<string, unknown>): boolean;
	now?(): number;
}

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

function streamKey(message: { daemonInstanceId: string; targetId: string; generation: number }): string {
	return `${message.daemonInstanceId} ${message.targetId} ${message.generation}`;
}

type CopilotAgent = ReturnType<CopilotAgentService["listOwnedAgents"]>[number];

/** How many frames one agent may hold pending reconciliation. A stream this far out of step is being
 * repaired by reconciliation rather than by patience. */
const MAX_DEFERRED_PER_AGENT = 128;

/** Whether there is anything to ask the daemon ABOUT. A record with no session names nothing a
 * reconcile command could carry, so no answer can ever arrive for it. */
function isAskable(agent: CopilotAgent): boolean {
	return agent.sessionId !== undefined && agent.resolvedTarget !== undefined;
}

/** A record whose owner still believes work is outstanding. These are what the gateway asks about on
 * reconnect; an idle agent has nothing a restarted daemon could contradict. */
function needsReconciliation(agent: CopilotAgent): boolean {
	return isAskable(agent) && (agent.agentState === "working" || agent.agentState === "recovering");
}

export class CopilotRelay {
	private readonly sections = new Map<string, Promise<unknown>>();
	private readonly streams = new Map<string, StreamProgress>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly reconciling = new Set<string>();
	private readonly deferred = new Map<string, Array<CopilotDaemonEvent | CopilotDaemonReceipt>>();

	constructor(private readonly deps: CopilotRelayDeps) {}

	dispatch(command: CopilotCommandRequest): boolean {
		const message = { type: "copilot_command", requestId: crypto.randomUUID(), ...command };
		if (!CopilotDaemonCommandSchema.safeParse(message).success) return false;
		return this.deps.sendToHost(message);
	}

	reconcileStale(owner: SessionRecord): void {
		const ownerKey = this.deps.sessionStore.teamOf(owner);
		for (const agent of this.deps.service.listOwnedAgents(owner)) {
			if (needsReconciliation(agent)) this.requestReconciliation(ownerKey, agent);
		}
	}

	handleHostMessage(raw: Record<string, unknown>): void {
		switch (raw.type) {
			case "copilot_hello":
				this.onHello(raw);
				return;
			case "copilot_receipt":
				this.onReceipt(raw);
				return;
			case "copilot_event":
				this.onEvent(raw);
				return;
			default:
				return;
		}
	}

	onAgentChange(ownerKey: string, agentId: string, listener: () => void): () => void {
		const key = agentKey(ownerKey, agentId);
		const set = this.listeners.get(key) ?? new Set<() => void>();
		set.add(listener);
		this.listeners.set(key, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(key);
		};
	}

	waitFor(ownerKey: string, agentId: string, settled: () => boolean, deadline: number): Promise<boolean> {
		if (settled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			let unsubscribe = () => {};
			const finish = (value: boolean) => {
				clearTimeout(timer);
				unsubscribe();
				resolve(value);
			};
			const timer = setTimeout(() => finish(false), Math.max(0, deadline - this.now()));
			unsubscribe = this.onAgentChange(ownerKey, agentId, () => {
				if (settled()) finish(true);
			});
		});
	}

	private onHello(raw: Record<string, unknown>): void {
		const hello = CopilotDaemonHelloSchema.safeParse(raw);
		if (!hello.success) return;
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.deps.service.listOwnedAgents(owner)) {
				// A HELD frame is a reason to ask in its own right: only a completed reconciliation
				// releases a hold, so an agent that has since gone idle would otherwise never be asked
				// about again and its frame would cap the whole target's acknowledgement.
				if (needsReconciliation(agent) || this.deferred.has(agentKey(ownerKey, agent.agentId))) {
					this.requestReconciliation(ownerKey, agent);
				}
			}
		}
	}

	private onReceipt(raw: Record<string, unknown>): void {
		const parsed = CopilotDaemonReceiptSchema.safeParse(raw);
		if (!parsed.success) return;
		void this.serialize(parsed.data.ownerKey, parsed.data.agentId, () => this.reduceReceipt(parsed.data));
	}

	private onEvent(raw: Record<string, unknown>): void {
		const parsed = CopilotDaemonEventSchema.safeParse(raw);
		if (!parsed.success) return;
		void this.serialize(parsed.data.ownerKey, parsed.data.agentId, () => this.reduceEvent(parsed.data));
	}

	private reduceReceipt(receipt: CopilotDaemonReceipt): void {
		const application = this.deps.service.applyReceipt(receipt, this.now());
		this.settle(receipt, application);
		if (receipt.kind === "rejected" && receipt.operationId !== undefined) return;
		if (receipt.kind !== "reconciled" && receipt.kind !== "rejected") return;
		const key = agentKey(receipt.ownerKey, receipt.agentId);
		if (!this.reconciling.delete(key)) return;
		if (application.disposition === "applied") this.drainDeferred(receipt.ownerKey, receipt.agentId);
	}

	private reduceEvent(event: CopilotDaemonEvent): void {
		this.settle(event, this.deps.service.applyEvent(event, this.now()));
	}

	private settle(message: CopilotDaemonEvent | CopilotDaemonReceipt, application: CopilotApplication): void {
		// A record nobody can ask about at all - no session yet - is genuinely decided: holding it
		// would cap the acknowledgement for every agent on that target with nothing left to release it.
		const repairable =
			application.disposition === "failed" ||
			(application.disposition === "reconcile" && isAskable(application.agent));
		if (repairable) {
			this.defer(message);
			if (application.disposition === "reconcile")
				this.requestReconciliation(message.ownerKey, application.agent);
		}
		if ("targetId" in message && "generation" in message) this.advance(message, repairable ? "hold" : "decided");
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
		// Named fields, never a spread: `advance` hands this a wider object, and the daemon's strict
		// ack schema rejects any extra key, which silently stops the outbox from ever being pruned.
		const sent = this.deps.sendToHost({
			type: "copilot_ack",
			daemonInstanceId: message.daemonInstanceId,
			targetId: message.targetId,
			generation: message.generation,
			throughEventId: through,
		});
		if (sent) progress.committedThrough = through;
	}

	private requestReconciliation(ownerKey: string, agent: CopilotAgent): void {
		if (!agent.sessionId || !agent.resolvedTarget) return;
		const key = agentKey(ownerKey, agent.agentId);
		if (this.reconciling.has(key)) return;
		this.reconciling.add(key);
		const sent = this.dispatch({
			kind: "reconcile",
			ownerKey,
			agentId: agent.agentId,
			target: agent.resolvedTarget,
			sessionId: agent.sessionId,
			...(agent.activeTurnId ? { turnId: agent.activeTurnId } : {}),
		});
		if (!sent) this.reconciling.delete(key);
	}

	private defer(message: CopilotDaemonEvent | CopilotDaemonReceipt): void {
		const key = agentKey(message.ownerKey, message.agentId);
		const held = this.deferred.get(key) ?? [];
		// The daemon replays every retained reliable frame on each reconnect, so without this the same
		// frame accumulates a copy per reconnect and the cap is reached by churn rather than by news.
		if (held.some((existing) => existing.type === message.type && existing.eventId === message.eventId)) return;
		held.push(message);
		this.deferred.set(key, held);
		while (held.length > MAX_DEFERRED_PER_AGENT) {
			// Activity goes first: the daemon sends it best-effort anyway, so dropping one costs a line
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
			for (const [eventId, owner] of progress.undecided) if (owner === key) progress.undecided.delete(eventId);
			this.releaseStream(streamId, progress);
		}
		if (!held?.length) return;
		// Oldest first, so a terminal cannot be re-applied ahead of the activity that preceded it.
		for (const message of [...held].sort((left, right) => left.eventId - right.eventId)) {
			if (message.type === "copilot_event") this.reduceEvent(message);
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

	private serialize(ownerKey: string, agentId: string, step: () => void): Promise<void> {
		const key = agentKey(ownerKey, agentId);
		const previous = this.sections.get(key) ?? Promise.resolve();
		const next = previous
			.then(step)
			.catch((error) => console.error("[copilot-relay] reducer step failed:", error))
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
