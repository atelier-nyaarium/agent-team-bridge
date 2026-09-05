// The host daemon as the gateway sees it.

import { randomBytes } from "node:crypto";
import type { GatewayGraph } from "../gateway/composeGateway.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../shared/agent-execution-target.js";
import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
} from "../shared/codexAgentRelay.js";
import type { HostOp } from "../shared/host-op.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";

export interface FakeHostHandlers {
	/** The scenario registers the launched session. */
	onCreateSession?: (op: Extract<HostOp, { kind: "createSession" }>) => void;
	/** The scenario registers the woken team. */
	onWake?: (frame: Frame) => void;
	/** Absent means accept and complete. */
	onCodexCommand?: CodexResponder;
}

export type CodexResponder = (command: CodexDaemonCommand, daemon: FakeCodexDaemon) => Array<Frame> | void;

export type FakeTurnState = "inProgress" | "completed" | "failed" | "interrupted";

/** One daemon process; outlives the socket. */
export interface FakeCodexDaemon {
	daemonInstanceId: string;
	generation: number;
	/** Targets the hello announces. */
	targets: Map<string, number>;
	/** What a reconcile answers per turn. */
	turns: Map<string, FakeTurnState>;
	/** Next event id per target. */
	nextEventId(targetId: string): number;
	resolve(target: AgentExecutionTarget): AgentResolvedTarget;
}

export interface FakeHostOptions extends FakeHostHandlers {
	token: string;
	/** Projects the catalog frame announces. */
	projects?: Array<{ team: string; projectPath: string }>;
	hostSpawns?: string[];
	screen?: string;
	entries?: string[];
	/** A reconnecting daemon brings its own. */
	daemon?: FakeCodexDaemon;
}

export interface FakeHost {
	frames: Frame[];
	/** Every relayed HostOp, in order. */
	ops: HostOp[];
	/** Every wake frame, in order. */
	wakes: Frame[];
	/** Every Codex command, schema-checked. */
	codexCommands: CodexDaemonCommand[];
	handlers: FakeHostHandlers;
	daemon: FakeCodexDaemon;
	/** One daemon frame to the gateway. */
	sendCodex(frame: CodexDaemonEvent | CodexDaemonReceipt): void;
	close(): void;
}

const HOST_HOME = "/home/fixture";

export function createFakeCodexDaemon(daemonInstanceId = `fake-daemon-${randomBytes(4).toString("hex")}`) {
	const eventIds = new Map<string, number>();
	const daemon: FakeCodexDaemon = {
		daemonInstanceId,
		generation: 1,
		targets: new Map(),
		turns: new Map(),
		nextEventId: (targetId) => {
			const next = (eventIds.get(targetId) ?? -1) + 1;
			eventIds.set(targetId, next);
			return next;
		},
		resolve: (target) =>
			target.kind === "host"
				? { kind: "host", targetId: "host", cwd: HOST_HOME }
				: { kind: "devcontainer", targetId: `container:${target.project}`, cwd: target.hostProjectPath },
	};
	return daemon;
}

export function attachFakeHost(graph: GatewayGraph, options: FakeHostOptions): FakeHost {
	const socket = createFakeSocket();
	const ops: HostOp[] = [];
	const wakes: Frame[] = [];
	const codexCommands: CodexDaemonCommand[] = [];
	const handlers: FakeHostHandlers = {
		onCreateSession: options.onCreateSession,
		onWake: options.onWake,
		onCodexCommand: options.onCodexCommand,
	};
	const daemon = options.daemon ?? createFakeCodexDaemon();
	const send = (frame: Frame): void => graph.wsHandlers.message(socket.ws, JSON.stringify(frame));
	const sendCodex = (frame: CodexDaemonEvent | CodexDaemonReceipt): void => {
		const checked =
			frame.type === "codex_event" ? CodexDaemonEventSchema.parse(frame) : CodexDaemonReceiptSchema.parse(frame);
		if (checked.type === "codex_receipt" && checked.kind === "accepted")
			daemon.turns.set(checked.turnId, "inProgress");
		if (checked.type === "codex_event" && checked.kind === "terminal")
			daemon.turns.set(checked.turnId, checked.state);
		send(checked);
	};
	const answer = (op: HostOp): unknown => {
		switch (op.kind) {
			case "peek":
				return { kind: "tmux", ansi: options.screen ?? "$ ", hash: "h1" };
			case "listDirs":
				return { entries: options.entries ?? ["projects"], path: op.path || HOST_HOME };
			case "createSession":
				// The shell comes up after the answer.
				setTimeout(() => handlers.onCreateSession?.(op), 0);
				return { created: true, ready: true, alive: true };
			case "sendText":
			case "sendKey":
				return { sent: true };
			case "killSession":
				return { killed: true };
			case "reloadPlugins":
				return { initiated: true };
		}
	};
	socket.onFrame((frame) => {
		if (frame.type === "host_op") {
			const op = frame.op as HostOp;
			ops.push(op);
			send({ type: "host_op_reply", reqId: frame.reqId, ok: true, result: answer(op) });
		}
		if (frame.type === "wake") {
			wakes.push(frame);
			handlers.onWake?.(frame);
			send({ type: "wake_result", team: frame.team, success: true });
		}
		if (frame.type === "codex_command") {
			const command = CodexDaemonCommandSchema.parse(frame);
			codexCommands.push(command);
			const targetId =
				command.kind === "start" ? daemon.resolve(command.target).targetId : command.target.targetId;
			if (!daemon.targets.has(targetId)) daemon.targets.set(targetId, daemon.generation);
			const responder = handlers.onCodexCommand ?? stockCodexResponder;
			for (const reply of responder(command, daemon) ?? [])
				sendCodex(reply as CodexDaemonEvent | CodexDaemonReceipt);
		}
	});
	graph.wsHandlers.open(socket.ws);
	send({ type: "register", team: "host", subId: "fake-host", token: options.token });
	send({ type: "catalog", projects: options.projects ?? [], hostSpawns: options.hostSpawns ?? [] });
	send({
		type: "codex_hello",
		daemonInstanceId: daemon.daemonInstanceId,
		targets: [...daemon.targets].map(([targetId, generation]) => ({ targetId, generation })),
	});
	return {
		frames: socket.sent,
		ops,
		wakes,
		codexCommands,
		handlers,
		daemon,
		sendCodex,
		close: () => {
			socket.ws.close();
			graph.wsHandlers.close(socket.ws);
		},
	};
}

/** Accepts every command and completes each turn at once. */
export const stockCodexResponder: CodexResponder = (command, daemon) => {
	const base = { ownerKey: command.ownerKey, daemonInstanceId: daemon.daemonInstanceId, agentId: command.agentId };
	if (command.kind === "start" || command.kind === "message") {
		const resolvedTarget = command.kind === "start" ? daemon.resolve(command.target) : command.target;
		const { targetId } = resolvedTarget;
		const threadId = command.kind === "start" ? `thread-${command.agentId}` : command.threadId;
		const turnId = `turn-${command.operationId}`;
		const fence = { targetId, generation: daemon.generation };
		return [
			{
				type: "codex_receipt",
				requestId: command.requestId,
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				kind: "accepted",
				operationId: command.operationId,
				resolvedTarget,
				threadId,
				turnId,
				delivery: "started",
			},
			{
				type: "codex_event",
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				threadId,
				kind: "activity",
				turnId,
				itemId: `item-${turnId}`,
				text: "working",
			},
			{
				type: "codex_event",
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				threadId,
				kind: "terminal",
				turnId,
				state: "completed",
				finalResponse: `done: ${command.prompt}`,
			},
		];
	}
	const { targetId } = command.target;
	const fence = { targetId, generation: daemon.generation };
	if (command.kind === "interrupt") {
		return [
			{
				type: "codex_receipt",
				requestId: command.requestId,
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				kind: "interruptResult",
				operationId: command.operationId,
				threadId: command.threadId,
				turnId: command.turnId,
				ok: true,
			},
		];
	}
	const turnState = command.turnId ? daemon.turns.get(command.turnId) : undefined;
	return [
		{
			type: "codex_receipt",
			requestId: command.requestId,
			...base,
			...fence,
			eventId: daemon.nextEventId(targetId),
			kind: "reconciled",
			resolvedTarget: command.target,
			threadId: command.threadId,
			...(command.turnId && turnState ? { turnId: command.turnId, turnState } : {}),
		},
	];
};
