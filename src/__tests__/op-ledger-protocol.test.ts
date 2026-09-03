import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeRouter,
	confirmHandshakeRole,
	connectToRouter,
	initBridge,
	opLedgerRefusal,
} from "../mcp/bridge/helpers.js";
import { OP_LEDGER_PROTOCOL } from "../shared/schemas.js";

const fakeSockets = vi.hoisted(() => ({ instances: [] as Array<{ emit: (event: string, value?: unknown) => void }> }));

vi.mock("ws", () => {
	class FakeSocket {
		private listeners = new Map<string, Array<(value?: unknown) => void>>();
		on(event: string, listener: (value?: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
		send(_value: string): void {}
		close(): void {}
		emit(event: string, value?: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) listener(value);
		}
	}
	return {
		default: class extends FakeSocket {
			constructor() {
				super();
				fakeSockets.instances.push(this);
			}
		},
	};
});

const BASE = { routerUrl: "http://localhost:20000", projectName: "host.abc123", agentType: "claude" };

afterEach(() => {
	closeRouter();
	fakeSockets.instances = [];
	vi.restoreAllMocks();
});

function connect(): (typeof fakeSockets.instances)[number] {
	initBridge(BASE);
	connectToRouter();
	const socket = fakeSockets.instances.at(-1)!;
	socket.emit("open");
	return socket;
}

describe("op-ledger protocol handshake", () => {
	it("refuses absent and old versions, allows current, and resets after reconnect", () => {
		const socket = connect();
		expect(opLedgerRefusal()).toContain("has not advertised");
		socket.emit("message", JSON.stringify({ type: "register_ok" }));
		expect(opLedgerRefusal()).toContain("has not advertised");
		socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: -1 }));
		expect(opLedgerRefusal()).toContain("older");
		socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
		expect(opLedgerRefusal()).toBeNull();
		socket.emit("close");
		expect(opLedgerRefusal()).toContain("has not advertised");
	});

	it("gates the handshake auto-reply until the current version is advertised", async () => {
		vi.useFakeTimers();
		try {
			const bodies: string[] = [];
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				bodies.push(String(init?.body));
				if (bodies.length < 3) throw new Error("offline");
				return new Response("{}");
			});
			const socket = connect();
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-old", replyJsonSchema: {} }),
			);
			confirmHandshakeRole("hs-old", true);
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-old", replyJsonSchema: {} }),
			);
			await Promise.resolve();
			expect(fetchMock).not.toHaveBeenCalled();

			socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-new", replyJsonSchema: {} }),
			);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(6_000);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(bodies).toHaveLength(3);
			expect(JSON.parse(bodies[1]).opId).toBe(JSON.parse(bodies[0]).opId);
			expect(JSON.parse(bodies[2]).opId).toBe(JSON.parse(bodies[0]).opId);
		} finally {
			vi.useRealTimers();
		}
	});
});
