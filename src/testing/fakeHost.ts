// The host daemon as the gateway sees it: one registered socket answering host_op and wake frames.

import type { GatewayGraph } from "../gateway/composeGateway.js";
import type { HostOp } from "../shared/host-op.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";

export interface FakeHostHandlers {
	/** The gateway asked the daemon to start a session; the scenario registers it. */
	onCreateSession?: (op: Extract<HostOp, { kind: "createSession" }>) => void;
	/** The gateway asked the daemon to wake a team; the scenario registers it. */
	onWake?: (frame: Frame) => void;
}

export interface FakeHostOptions extends FakeHostHandlers {
	token: string;
	/** Projects the catalog frame announces. */
	projects?: Array<{ team: string; projectPath: string }>;
	hostSpawns?: string[];
	screen?: string;
	entries?: string[];
}

export interface FakeHost {
	frames: Frame[];
	/** Every HostOp the gateway relayed, in order. */
	ops: HostOp[];
	/** Every wake frame the gateway sent, in order. */
	wakes: Frame[];
	handlers: FakeHostHandlers;
	close(): void;
}

export function attachFakeHost(graph: GatewayGraph, options: FakeHostOptions): FakeHost {
	const socket = createFakeSocket();
	const ops: HostOp[] = [];
	const wakes: Frame[] = [];
	const handlers: FakeHostHandlers = { onCreateSession: options.onCreateSession, onWake: options.onWake };
	const answer = (op: HostOp): unknown => {
		switch (op.kind) {
			case "peek":
				return { kind: "tmux", ansi: options.screen ?? "$ ", hash: "h1" };
			case "listDirs":
				return { entries: options.entries ?? ["projects"], path: op.path || "/home/fixture" };
			case "createSession":
				handlers.onCreateSession?.(op);
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
			graph.wsHandlers.message(
				socket.ws,
				JSON.stringify({ type: "host_op_reply", reqId: frame.reqId, ok: true, result: answer(op) }),
			);
		}
		if (frame.type === "wake") {
			wakes.push(frame);
			handlers.onWake?.(frame);
			graph.wsHandlers.message(
				socket.ws,
				JSON.stringify({ type: "wake_result", team: frame.team, success: true }),
			);
		}
	});
	graph.wsHandlers.open(socket.ws);
	graph.wsHandlers.message(
		socket.ws,
		JSON.stringify({ type: "register", team: "host", subId: "fake-host", token: options.token }),
	);
	graph.wsHandlers.message(
		socket.ws,
		JSON.stringify({ type: "catalog", projects: options.projects ?? [], hostSpawns: options.hostSpawns ?? [] }),
	);
	return {
		frames: socket.sent,
		ops,
		wakes,
		handlers,
		close: () => {
			socket.ws.close();
			graph.wsHandlers.close(socket.ws);
		},
	};
}
