import { type AgentBackendId, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import type { TargetLease, TargetSupervisor } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentDaemonSession {
	targetId: string;
	generation: number;
	nextEventId: number;
	client: { close(): void };
}

export interface AgentDaemonSchema<T> {
	safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface AgentEventAck {
	type?: string;
	daemonInstanceId?: string;
	targetId: string;
	generation: number;
	throughEventId: number;
}

export interface AgentDaemonCoreOptions {
	backendId: AgentBackendId;
	daemonInstanceId: string;
	targets: TargetSupervisor;
	send(message: Record<string, unknown>): void;
	isReliable(message: unknown): boolean;
	// Validates hello() before it is sent, matching every sibling frame on this wire. The receiver's
	// schema is .strict(), so an unvalidated drift here is rejected at the far end with no local sign.
	helloSchema?: { parse(value: unknown): unknown };
}

interface AgentCommand {
	ownerKey: string;
	agentId: string;
}

type EventIdPlacement = "first" | "last";

////////////////////////////////
//  Constants

const OUTBOX_MAX_ENTRIES = 1_000;

////////////////////////////////
//  Class

/**
 * What every agent daemon shares: which generation serves a target, and the stream back to the
 * gateway.
 *
 * It owns the registry and the fence over it, so a backend cannot publish under a generation the
 * gateway has retired. Protocol belongs to the service above it.
 */
export class AgentDaemonCore<TSession extends AgentDaemonSession> {
	private readonly sessions = new Map<string, TSession>();
	private readonly opening = new Map<string, Promise<TSession | null>>();
	private readonly outbox: Array<{ targetId: string; generation: number; eventId: number; message: object }> = [];
	private readonly inflight = new Map<string, Promise<void>>();
	private rejections = 0;

	constructor(private readonly options: AgentDaemonCoreOptions) {}

	hello(): Record<string, unknown> {
		const frame = {
			type: agentFrameType(this.options.backendId, "hello"),
			daemonInstanceId: this.options.daemonInstanceId,
			targets: [...this.sessions.values()].map((session) => ({
				targetId: session.targetId,
				generation: session.generation,
			})),
		};
		this.options.helloSchema?.parse(frame);
		return frame;
	}

	replay(): void {
		for (const entry of [...this.outbox].sort((left, right) => left.eventId - right.eventId)) {
			this.options.send(entry.message as Record<string, unknown>);
		}
	}

	acknowledge(ack: AgentEventAck): void {
		for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
			const entry = this.outbox[index]!;
			if (
				entry.targetId === ack.targetId &&
				entry.generation === ack.generation &&
				entry.eventId <= ack.throughEventId
			) {
				this.outbox.splice(index, 1);
			}
		}
	}

	enqueue<TCommand extends AgentCommand>(
		command: TCommand,
		dispatch: (command: TCommand) => Promise<void>,
		reject: (command: TCommand, error: string) => void,
		describe: (error: unknown) => string,
	): void {
		const key = `${command.ownerKey} ${command.agentId}`;
		const previous = this.inflight.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => dispatch(command))
			.catch((error) => reject(command, describe(error)))
			.finally(() => {
				if (this.inflight.get(key) === next) this.inflight.delete(key);
			});
		this.inflight.set(key, next);
	}

	async acquireSession(
		target: AgentResolvedTarget,
		buildSession: (target: AgentResolvedTarget, lease: TargetLease) => Promise<TSession | null>,
	): Promise<TSession | null> {
		const availability = this.options.targets.acquire(target);
		if (availability.state !== "running") return null;
		const generation = availability.lease.generation;
		const existing = this.sessions.get(target.targetId);
		if (existing && existing.generation === generation) return existing;

		const key = `${target.targetId} ${generation}`;
		const inflight = this.opening.get(key);
		if (inflight) return inflight;
		const opening = this.open(target, availability.lease, buildSession).finally(() => {
			if (this.opening.get(key) === opening) this.opening.delete(key);
		});
		this.opening.set(key, opening);
		return opening;
	}

	getSession(targetId: string): TSession | undefined {
		return this.sessions.get(targetId);
	}

	/**
	 * Whether this generation still serves its target, which is what every publisher must ask.
	 *
	 * Tracking retirement BESIDE the registry rather than in it was tried and silenced a healthy
	 * child, so `retire` drops the session and this one question answers both.
	 */
	live(session: TSession): boolean {
		return this.sessions.get(session.targetId) === session;
	}

	/** Give up a generation: it serves and publishes nothing new. Retained entries still replay. */
	retire(session: TSession): void {
		if (this.live(session)) this.sessions.delete(session.targetId);
	}

	shutdown(): void {
		for (const session of this.sessions.values()) session.client.close();
		this.sessions.clear();
	}

	rejectionId(): number {
		this.rejections += 1;
		return this.rejections;
	}

	publish<T>(
		session: TSession,
		partial: Record<string, unknown>,
		schema: AgentDaemonSchema<T>,
		eventIdPlacement: EventIdPlacement = "last",
	): void {
		// The gateway fences a retired generation out, so publishing under one only looks delivered.
		if (!this.live(session)) {
			console.error(
				`[${this.options.backendId}-daemon] dropped a ${partial.kind} from a retired generation on ${session.targetId}`,
			);
			return;
		}
		const eventId = session.nextEventId;
		session.nextEventId += 1;
		const message =
			eventIdPlacement === "first"
				? {
						daemonInstanceId: this.options.daemonInstanceId,
						targetId: session.targetId,
						generation: session.generation,
						eventId,
						...partial,
					}
				: {
						daemonInstanceId: this.options.daemonInstanceId,
						targetId: session.targetId,
						generation: session.generation,
						...partial,
						eventId,
					};
		const parsed = schema.safeParse(message);
		if (!parsed.success) {
			// Silence here loses a terminal whose thread the lifecycle unloads regardless.
			console.error(
				`[${this.options.backendId}-daemon] dropped an unpublishable ${partial.kind} on ${session.targetId}`,
			);
			return;
		}
		if (this.options.isReliable(parsed.data)) this.retain(session.targetId, session.generation, eventId, message);
		this.options.send(message);
	}

	private async open(
		target: AgentResolvedTarget,
		lease: TargetLease,
		buildSession: (target: AgentResolvedTarget, lease: TargetLease) => Promise<TSession | null>,
	): Promise<TSession | null> {
		const before = this.sessions.get(target.targetId);
		// An open for an older generation must not close the one already serving, nor replace it when
		// it finishes. The caller is handed that live session instead, since its target is healthy.
		if (before && before.generation > lease.generation) return before;
		if (before) {
			// Deregistered before it is closed: a closed session left registered is still advertised by
			// hello() and still passes the publish fence.
			this.sessions.delete(target.targetId);
			before.client.close();
		}
		const session = await buildSession(target, lease);
		if (!session) return null;
		const current = this.sessions.get(target.targetId);
		if (current && current.generation > session.generation) {
			session.client.close();
			return current;
		}
		this.sessions.set(target.targetId, session);
		return session;
	}

	private retain(targetId: string, generation: number, eventId: number, message: object): void {
		this.outbox.push({ targetId, generation, eventId, message });
		const sameStream = (entry: { targetId: string; generation: number }) =>
			entry.targetId === targetId && entry.generation === generation;
		while (this.outbox.filter(sameStream).length > OUTBOX_MAX_ENTRIES) {
			const index = this.outbox.findIndex(sameStream);
			if (index < 0) break;
			const [dropped] = this.outbox.splice(index, 1);
			console.error(
				`[${this.options.backendId}-daemon] outbox overflow, dropped event ${dropped?.eventId} on ${targetId}`,
			);
		}
	}
}
