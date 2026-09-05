import type { Ambient } from "../shared/ambient.js";
import {
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	CopilotDaemonHelloSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
} from "../shared/copilot-agent.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import { RECONCILE_GUARD_MS } from "./codexRelay.js";
import type { CopilotAgentService } from "./copilotAgentService.js";
import type { CopilotApplication } from "./copilotAgentTypes.js";

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
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
}

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

function streamKey(message: { daemonInstanceId: string; targetId: string; generation: number }): string {
	return `${message.daemonInstanceId} ${message.targetId} ${message.generation}`;
}

type CopilotAgent = ReturnType<CopilotAgentService["listOwnedAgents"]>[number];

// Deferred frames are bounded per agent; reconciliation releases their holds.
const MAX_DEFERRED_PER_AGENT = 128;

function isAskable(agent: CopilotAgent): boolean {
	return agent.sessionId !== undefined && agent.resolvedTarget !== undefined;
}

function needsReconciliation(agent: CopilotAgent): boolean {
	return isAskable(agent) && (agent.agentState === "working" || agent.agentState === "recovering");
}

export class CopilotRelay {
	private readonly sections = new Map<string, Promise<unknown>>();
	private readonly streams = new Map<string, StreamProgress>();
	private readonly listeners = new Map<string, Set<() => void>>();
	// Reconciliation guards expire so a silent daemon cannot hold frames forever.
	private readonly reconciling = new Map<string, number>();
	private readonly deferred = new Map<string, Array<CopilotDaemonEvent | CopilotDaemonReceipt>>();

	constructor(private readonly deps: CopilotRelayDeps) {}

	dispatch(command: CopilotCommandRequest): boolean {
		const message = { type: "copilot_command", requestId: this.deps.ambient.newId(), ...command };
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
				this.deps.ambient.clearTimer(timer);
				unsubscribe();
				resolve(value);
			};
			const timer = this.deps.ambient.setTimer(() => finish(false), Math.max(0, deadline - this.now()));
			unsubscribe = this.onAgentChange(ownerKey, agentId, () => {
				if (settled()) finish(true);
			});
		});
	}

	private onHello(raw: Record<string, unknown>): void {
		const hello = CopilotDaemonHelloSchema.safeParse(raw);
		if (!hello.success) return;
		this.reconciling.clear();
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.deps.service.listOwnedAgents(owner)) {
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
		// Unaskable records are decided; only askable work can remain held.
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
		// Keep acknowledgements schema-exact; wider command objects are rejected.
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
		const askedAt = this.reconciling.get(key);
		if (askedAt !== undefined && this.now() - askedAt < RECONCILE_GUARD_MS) return;
		this.reconciling.set(key, this.now());
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
		// Daemon replay makes event and receipt deduplication necessary across reconnects.
		if (held.some((existing) => existing.type === message.type && existing.eventId === message.eventId)) return;
		held.push(message);
		this.deferred.set(key, held);
		while (held.length > MAX_DEFERRED_PER_AGENT) {
			// Evict activity before receipts; reconciliation releases either hold.
			const index = held.findIndex((candidate) => candidate.kind === "activity");
			held.splice(index >= 0 ? index : 0, 1);
		}
	}

	private drainDeferred(ownerKey: string, agentId: string): void {
		const key = agentKey(ownerKey, agentId);
		const held = this.deferred.get(key);
		this.deferred.delete(key);
		// Reconciliation supersedes every undecided frame for this agent.
		for (const [streamId, progress] of this.streams) {
			for (const [eventId, owner] of progress.undecided) if (owner === key) progress.undecided.delete(eventId);
			this.releaseStream(streamId, progress);
		}
		if (!held?.length) return;
		// Reapply deferred frames in event order.
		for (const message of [...held].sort((left, right) => left.eventId - right.eventId)) {
			if (message.type === "copilot_event") this.reduceEvent(message);
			else this.reduceReceipt(message);
		}
	}

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
		return this.deps.ambient.now();
	}
}
