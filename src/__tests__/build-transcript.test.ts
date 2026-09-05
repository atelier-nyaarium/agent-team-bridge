import { describe, expect, it } from "vitest";
import { appendBuildTranscript, beginBuildTranscript, buildTranscript } from "../mcp/devcontainer/buildTranscript.js";

describe("build transcript", () => {
	it("keeps the tail past the cap and starts over on the next up", () => {
		beginBuildTranscript("halo");
		appendBuildTranscript("halo", "x".repeat(16_000));
		appendBuildTranscript("halo", "y".repeat(1_000));
		const held = buildTranscript("halo") ?? "";
		expect(held).toHaveLength(16_384);
		expect(held.endsWith("y".repeat(1_000))).toBe(true);
		expect(held.startsWith("x")).toBe(true);

		beginBuildTranscript("halo");
		expect(buildTranscript("halo")).toBe("");
		expect(buildTranscript("other")).toBeUndefined();
	});
});
