import { describe, expect, it } from "vitest";
import { relativeAge } from "../mcp/bridge/bridgeDiscover.js";

describe("relativeAge", () => {
	const now = 1_000_000_000_000;
	it("reads under a minute as just now", () => {
		expect(relativeAge(now - 30_000, now)).toBe("just now");
		expect(relativeAge(now, now)).toBe("just now");
	});
	it("buckets minutes, hours, and days", () => {
		expect(relativeAge(now - 5 * 60_000, now)).toBe("5m ago");
		expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h ago");
		expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d ago");
	});
	it("clamps a future timestamp to just now (no negative age)", () => {
		expect(relativeAge(now + 10_000, now)).toBe("just now");
	});
});
