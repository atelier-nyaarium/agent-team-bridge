// Stage 7: the awareness bank that rides changes out on the next channel push.

import type { AwarenessObservation } from "../../shared/awareness-types.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import { type AwarenessBank, createAwarenessBank } from "../awarenessBank.js";
import { boardAwarenessSubscriber } from "../boardAwareness.js";
import { resolveLiveIncarnation } from "../websocket.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AwarenessStageDeps {
	sessions: SessionsStage;
	host: Pick<HostStage, "wakeService">;
}

export interface AwarenessStage {
	awareness: AwarenessBank;
	boardObserve: (observations: readonly AwarenessObservation<BoardEntry>[]) => void;
	awarenessTimer: ReturnType<typeof setInterval>;
}

export function composeAwareness({ sessions, host }: AwarenessStageDeps): AwarenessStage {
	const awareness = createAwarenessBank({
		liveness: (sessionKey) => {
			const live = resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionKey);
			if (live?.data.handshakeConfirmed) return "live";
			if (live || host.wakeService.isWakeInFlight(sessionKey)) return "waking";
			return "gone";
		},
		deliver: (sessionKey, payload) => {
			const live = resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionKey);
			if (!live?.data.handshakeConfirmed) return false;
			live.send(JSON.stringify(payload));
			return true;
		},
	});
	const boardObserve = awareness.register(boardAwarenessSubscriber);
	const awarenessTimer = setInterval(() => {
		try {
			awareness.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);
	awarenessTimer.unref?.();

	return { awareness, boardObserve, awarenessTimer };
}
