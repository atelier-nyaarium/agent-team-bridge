import { describe, expect, it } from "vitest";
import { resolveWindowsWorkdir } from "../mcp/devcontainer/windowsSpawn.js";
import { GatewaySpawnPointsSchema } from "../shared/schemas.js";

describe("gateway spawn point values", () => {
	it("resolves labels and Windows paths", () => {
		const home = "C:\\Users\\me";
		expect(resolveWindowsWorkdir("My Session", home)).toEqual({ workdir: home });
		expect(resolveWindowsWorkdir(undefined, home)).toEqual({ workdir: home });
		expect(resolveWindowsWorkdir("D:\\work", home)).toEqual({ workdir: "D:\\work" });
	});

	it("validates optional domains and bounded spawn lists", () => {
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: [] }).success).toBe(true);
		expect(GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: ["windows"] }).success).toBe(true);
		expect(
			GatewaySpawnPointsSchema.safeParse({ gatewayId: "g", hostSpawns: Array.from({ length: 9 }, () => "x") })
				.success,
		).toBe(false);
	});
});
