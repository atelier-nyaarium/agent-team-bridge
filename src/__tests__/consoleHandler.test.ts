import { describe, expect, it } from "vitest";
import { CREATE_SESSION_BOUND_MS } from "../gateway/console/consoleHandler.js";
import { MAX_POLL_HOLD_MS } from "../shared/schemas.js";

describe("consoleHandler constants", () => {
	it("CREATE_SESSION_BOUND_MS stays comfortably under the Android console's SPAWN_RETRY_WINDOW_MS", () => {
		// android/.../ChatRepository.kt: internal const val SPAWN_RETRY_WINDOW_MS = 40_000L
		const androidSpawnRetryWindowMs = 40_000;
		expect(CREATE_SESSION_BOUND_MS).toBeLessThan(androidSpawnRetryWindowMs - 10_000);
	});
});

describe("schemas constants", () => {
	it("MAX_POLL_HOLD_MS stays at or above the Android console's LONG_POLL_HOLD_MS", () => {
		// android/.../ChatRepository.kt: internal companion object { const val LONG_POLL_HOLD_MS = 40_000L }
		const androidLongPollHoldMs = 40_000;
		expect(MAX_POLL_HOLD_MS).toBeGreaterThanOrEqual(androidLongPollHoldMs);
	});
});
