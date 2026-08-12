import crypto from "node:crypto";
import {
	COPILOT_DEFAULT_MODEL,
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	type CopilotDaemonFailureCode,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	type CopilotEventAck,
	type CopilotResolvedTarget,
	isReliableCopilotMessage,
	sanitizeCopilotErrorText,
} from "../../shared/copilot-thinking.js";
import { resolveCodexTarget } from "./codexTargetResolve.js";
import type { TargetLease, TargetSupervisor } from "./codexTargets.js";
import { type CopilotAcpClient, defaultOpenCopilotClient } from "./copilotAcp.js";
import type { CopilotChild } from "./copilotTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface CopilotDaemonDeps {
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	openClient?(child: CopilotChild): Promise<CopilotAcpClient>;
	resolveHostCwd(hint: string | undefined): string;
	now?(): number;
}

interface Binding {
	ownerKey: string;
	agentId: string;
	sessionId: string;
}

interface ActivePrompt {
	binding: Binding;
	turnId: string;
	response: string;
	cancelled: boolean;
}

interface TargetSession {
	targetId: string;
	generation: number;
	client: CopilotAcpClient;
	nextEventId: number;
	sessions: Map<string, Binding>;
	active: Map<string, ActivePrompt>;
}

////////////////////////////////
//  Functions & Helpers

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCopilotErrorText(text) || "Copilot command failed";
}

function failureCode(error: string): CopilotDaemonFailureCode {
	if (/auth|login|not logged in|unauthori[sz]ed|credential/i.test(error)) return "authentication_required";
	if (/protocol version|unsupported ACP|incompatible/i.test(error)) return "protocol_incompatible";
	if (/timed out|timeout|exited|closed|broken pipe/i.test(error)) return "app_server_unavailable";
	if (/target|container|binary|unavailable/i.test(error)) return "daemon_unavailable";
	return "protocol_error";
}

export function resolveCopilotTarget(
	target: Parameters<typeof resolveCodexTarget>[0],
	resolveHostCwd: (hint: string | undefined) => string,
): CopilotResolvedTarget {
	return resolveCodexTarget(target, resolveHostCwd);
}

////////////////////////////////
//  Class

export class CopilotDaemonService {
	private readonly sessions = new Map<string, TargetSession>();
	private readonly opening = new Map<string, Promise<TargetSession | null>>();
	private readonly openErrors = new Map<string, string>();
	private readonly outbox: Array<{ targetId: string; generation: number; eventId: number; message: object }> = [];
	private readonly inflight = new Map<string, Promise<void>>();
	private rejections = 0;

	constructor(private readonly deps: CopilotDaemonDeps) {}

	hello(): Record<string, unknown> {
		return {
			type: "copilot_hello",
			daemonInstanceId: this.deps.daemonInstanceId,
			targets: [...this.sessions.values()].map((session) => ({
				targetId: session.targetId,
				generation: session.generation,
			})),
		};
	}

	replay(): void {
		for (const entry of [...this.outbox].sort((left, right) => left.eventId - right.eventId)) {
			this.deps.send(entry.message as Record<string, unknown>);
		}
	}

	acknowledge(ack: CopilotEventAck): void {
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

	handleCommand(raw: unknown): void {
		const parsed = CopilotDaemonCommandSchema.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		const key = `${command.ownerKey} ${command.agentId}`;
		const previous = this.inflight.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => this.dispatch(command))
			.catch((error) => this.reject(command, describe(error)))
			.finally(() => {
				if (this.inflight.get(key) === next) this.inflight.delete(key);
			});
		this.inflight.set(key, next);
	}

	shutdown(): void {
		for (const session of this.sessions.values()) session.client.close();
		this.sessions.clear();
	}

	private async dispatch(command: CopilotDaemonCommand): Promise<void> {
		switch (command.kind) {
			case "start":
				return this.runStart(command);
			case "message":
				return this.runMessage(command);
			case "interrupt":
				return this.runInterrupt(command);
			case "reconcile":
				return this.runReconcile(command);
		}
	}

	private async runStart(command: Extract<CopilotDaemonCommand, { kind: "start" }>): Promise<void> {
		const target = resolveCopilotTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(target);
		if (!session)
			return this.reject(command, this.openErrors.get(target.targetId) ?? "execution target is unavailable");
		const info = await session.client.newSession(target.cwd, command.model ?? COPILOT_DEFAULT_MODEL);
		const turnId = crypto.randomUUID();
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, sessionId: info.sessionId };
		session.sessions.set(info.sessionId, binding);
		this.emitReceipt(session, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: target,
			sessionId: info.sessionId,
			turnId,
			delivery: "started",
		});
		void this.runPrompt(session, binding, turnId, command.prompt);
	}

	private async runMessage(command: Extract<CopilotDaemonCommand, { kind: "message" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? "execution target is unavailable",
			);
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, sessionId: command.sessionId };
		if (session.active.has(command.sessionId)) return this.reject(command, "Copilot agent is still working");
		if (!session.sessions.has(command.sessionId)) {
			try {
				await session.client.loadSession(command.sessionId, command.target.cwd);
			} catch (error) {
				return this.reject(command, describe(error));
			}
			session.sessions.set(command.sessionId, binding);
		}
		const turnId = crypto.randomUUID();
		this.emitReceipt(session, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: command.target,
			sessionId: command.sessionId,
			turnId,
			delivery: "followup",
		});
		void this.runPrompt(session, binding, turnId, command.prompt);
	}

	private async runPrompt(session: TargetSession, binding: Binding, turnId: string, prompt: string): Promise<void> {
		const active: ActivePrompt = { binding, turnId, response: "", cancelled: false };
		session.active.set(binding.sessionId, active);
		try {
			const result = await session.client.prompt(binding.sessionId, prompt);
			if (session.active.get(binding.sessionId) !== active) return;
			session.active.delete(binding.sessionId);
			const interrupted = active.cancelled || result.stopReason === "cancelled";
			this.emitEvent(session, {
				kind: "terminal",
				ownerKey: binding.ownerKey,
				agentId: binding.agentId,
				sessionId: binding.sessionId,
				turnId,
				state: interrupted ? "interrupted" : "completed",
				...(interrupted ? {} : { finalResponse: active.response }),
			});
		} catch (error) {
			if (session.active.get(binding.sessionId) !== active) return;
			session.active.delete(binding.sessionId);
			this.emitEvent(session, {
				kind: "terminal",
				ownerKey: binding.ownerKey,
				agentId: binding.agentId,
				sessionId: binding.sessionId,
				turnId,
				state: "failed",
				error: describe(error),
			});
		}
	}

	private async runInterrupt(command: Extract<CopilotDaemonCommand, { kind: "interrupt" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? "execution target is unavailable",
			);
		const active = session.active.get(command.sessionId);
		if (!active || active.turnId !== command.turnId)
			return this.reject(command, "Copilot turn is no longer active");
		active.cancelled = true;
		session.client.cancel(command.sessionId);
		this.emitReceipt(session, {
			kind: "interruptResult",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			sessionId: command.sessionId,
			turnId: command.turnId,
			ok: true,
		});
	}

	private async runReconcile(command: Extract<CopilotDaemonCommand, { kind: "reconcile" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? "execution target is unavailable",
			);
		const active = session.active.get(command.sessionId);
		if (!active) {
			try {
				await session.client.loadSession(command.sessionId, command.target.cwd);
			} catch (error) {
				return this.reject(command, describe(error));
			}
			session.sessions.set(command.sessionId, {
				ownerKey: command.ownerKey,
				agentId: command.agentId,
				sessionId: command.sessionId,
			});
		}
		this.emitReceipt(session, {
			kind: "reconciled",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			sessionId: command.sessionId,
			turnId: active?.turnId ?? command.turnId,
			active: !!active,
		});
	}

	private async session(target: CopilotResolvedTarget): Promise<TargetSession | null> {
		const availability = this.deps.targets.acquire(target);
		if (availability.state !== "running") return null;
		const generation = availability.lease.generation;
		const existing = this.sessions.get(target.targetId);
		if (existing && existing.generation === generation) return existing;
		const key = `${target.targetId} ${generation}`;
		const inflight = this.opening.get(key);
		if (inflight) return inflight;
		const opening = this.open(target, availability.lease).finally(() => {
			if (this.opening.get(key) === opening) this.opening.delete(key);
		});
		this.opening.set(key, opening);
		return opening;
	}

	private async open(target: CopilotResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		this.sessions.get(target.targetId)?.client.close();
		const opened = this.deps.openClient ?? defaultOpenCopilotClient;
		let client: CopilotAcpClient;
		try {
			client = await opened(lease.child);
		} catch (error) {
			this.openErrors.set(target.targetId, describe(error));
			this.deps.targets.release(target.targetId);
			return null;
		}
		this.openErrors.delete(target.targetId);
		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			nextEventId: 0,
			sessions: new Map(),
			active: new Map(),
		};
		client.onEvent((event) => this.onEvent(session, event));
		this.sessions.set(target.targetId, session);
		return session;
	}

	private onEvent(session: TargetSession, event: { method: string; params?: unknown }): void {
		if (event.method !== "session/update" || typeof event.params !== "object" || event.params === null) return;
		const params = event.params as { sessionId?: unknown; update?: unknown };
		if (typeof params.sessionId !== "string" || typeof params.update !== "object" || params.update === null) return;
		const active = session.active.get(params.sessionId);
		if (!active) return;
		const update = params.update as {
			sessionUpdate?: unknown;
			content?: unknown;
			title?: unknown;
			status?: unknown;
		};
		if (
			update.sessionUpdate === "agent_message_chunk" &&
			typeof update.content === "object" &&
			update.content !== null
		) {
			const content = update.content as { type?: unknown; text?: unknown };
			if (content.type === "text" && typeof content.text === "string") {
				active.response += content.text;
				this.emitEvent(session, {
					kind: "activity",
					ownerKey: active.binding.ownerKey,
					agentId: active.binding.agentId,
					sessionId: active.binding.sessionId,
					turnId: active.turnId,
					itemId: crypto.randomUUID(),
					text: content.text,
				});
			}
			return;
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const label =
				typeof update.title === "string"
					? update.title
					: typeof update.status === "string"
						? update.status
						: "Copilot used a tool";
			this.emitEvent(session, {
				kind: "activity",
				ownerKey: active.binding.ownerKey,
				agentId: active.binding.agentId,
				sessionId: active.binding.sessionId,
				turnId: active.turnId,
				itemId: crypto.randomUUID(),
				text: label,
			});
		}
	}

	private emitEvent(session: TargetSession, event: Record<string, unknown>): void {
		this.publish(session, { type: "copilot_event", ...event }, CopilotDaemonEventSchema);
	}

	private emitReceipt(session: TargetSession, receipt: Record<string, unknown>): void {
		this.publish(
			session,
			{
				type: "copilot_receipt",
				daemonInstanceId: this.deps.daemonInstanceId,
				targetId: session.targetId,
				generation: session.generation,
				...receipt,
			},
			CopilotDaemonReceiptSchema,
		);
	}

	private publish(
		session: TargetSession,
		partial: Record<string, unknown>,
		schema: {
			safeParse(
				value: unknown,
			): { success: true; data: CopilotDaemonEvent | CopilotDaemonReceipt } | { success: false };
		},
	): void {
		const eventId = session.nextEventId++;
		const message = {
			daemonInstanceId: this.deps.daemonInstanceId,
			targetId: session.targetId,
			generation: session.generation,
			eventId,
			...partial,
		};
		const parsed = schema.safeParse(message);
		if (!parsed.success) return;
		if (isReliableCopilotMessage(parsed.data)) this.retain(session.targetId, session.generation, eventId, message);
		this.deps.send(message);
	}

	private retain(targetId: string, generation: number, eventId: number, message: object): void {
		this.outbox.push({ targetId, generation, eventId, message });
		const sameStream = (entry: { targetId: string; generation: number }) =>
			entry.targetId === targetId && entry.generation === generation;
		while (this.outbox.filter(sameStream).length > 1_000) {
			const index = this.outbox.findIndex(sameStream);
			if (index < 0) break;
			this.outbox.splice(index, 1);
		}
	}

	private reject(command: CopilotDaemonCommand, error: string): void {
		const normalized = sanitizeCopilotErrorText(error) || "Copilot command failed";
		const message = {
			type: "copilot_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			daemonInstanceId: this.deps.daemonInstanceId,
			agentId: command.agentId,
			...(command.kind === "reconcile" ? {} : { operationId: command.operationId }),
			eventId: ++this.rejections,
			failureCode: failureCode(normalized),
			error: normalized,
		};
		if (CopilotDaemonReceiptSchema.safeParse(message).success) this.deps.send(message);
	}
}

export type { CopilotDaemonEvent, CopilotDaemonReceipt };
