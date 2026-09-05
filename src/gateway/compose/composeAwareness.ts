// The awareness bank that rides changes out on the next channel push.

import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { AwarenessObservation } from "../../shared/awareness-types.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import { type AwarenessBank, createAwarenessBank } from "../awarenessBank.js";
import { boardAwarenessSubscriber } from "../boardAwareness.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AwarenessStageDeps {
	sessions: Pick<SessionsStage, "registry" | "sessionStore">;
	host: Pick<HostStage, "wakeService">;
	ambient: Pick<Ambient, "now" | "randomBytes" | "setInterval">;
}

export interface AwarenessStage {
	awareness: AwarenessBank;
	boardObserve: (observations: readonly AwarenessObservation<BoardEntry>[]) => void;
	awarenessTimer: IntervalHandle;
}

export function composeAwareness({ sessions, host, ambient }: AwarenessStageDeps): AwarenessStage {
	const awareness = createAwarenessBank({
		ambient,
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
	const awarenessTimer = ambient.setInterval(() => {
		try {
			awareness.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);

	return { awareness, boardObserve, awarenessTimer };
}
