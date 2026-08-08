import type { ServerWebSocket } from "bun";
import { vi } from "vitest";
import { createSessionAuthority } from "../../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "../../gateway/websocket.js";
import type { SessionStore } from "../../shared/session-store.js";

////////////////////////////////
//  Functions & Helpers

/** The production authority, so a test exercises the real gate rather than an ungated gateway. */
export function authFor(registry: TeamRegistry, sessionStore?: SessionStore) {
	return createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "test-host",
	});
}

export function createMockWs() {
	return {
		data: { teamName: null, subId: "", conversationId: null, missedPings: 0, isStale: false } as WsData,
		readyState: 1,
		close: vi.fn(),
		ping: vi.fn(),
		send: vi.fn(),
	} as unknown as ServerWebSocket<WsData>;
}

/** The random `hs-...` session id the gateway sent this socket in its handshake push. */
export function handshakeIdFrom(ws: ServerWebSocket<WsData>): string {
	const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));
	const hs = calls.reverse().find((m) => m.type === "channel_push" && m.from === "gateway" && m.replyJsonSchema);
	return hs.session_id as string;
}

/** How many handshake pushes this socket has been sent in total. */
export function handshakePushCount(ws: ServerWebSocket<WsData>): number {
	const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));
	return calls.filter((m) => m.type === "channel_push" && m.from === "gateway" && m.replyJsonSchema).length;
}
