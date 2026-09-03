import { describe, expect, it } from "vitest";
import { CREATE_SESSION_BOUND_MS } from "../gateway/console/consoleHandler.js";

describe("console handler constants", () => {
	it("keeps the create session bound below the Android retry window", () => {
		const androidSpawnRetryWindowMs = 30_000;
		expect(CREATE_SESSION_BOUND_MS).toBeLessThan(androidSpawnRetryWindowMs);
	});
});
