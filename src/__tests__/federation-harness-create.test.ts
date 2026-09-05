import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** Whether any string leaf of `value` names `needle`. */
function carries(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (Array.isArray(value)) return value.some((item) => carries(item, needle));
	if (value && typeof value === "object") return Object.values(value).some((item) => carries(item, needle));
	return false;
}

describe("federation harness: a create the launch fails", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness({
			wakeTimeoutMs: 300,
			host: { projects: [{ team: "halo", projectPath: "/home/fixture/halo" }] },
		});
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("keeps the record when nothing inside the container ever registers, and lists it asleep", async () => {
		const team = "halo.explorer";
		const { result } = await h.phone.value({ kind: "create_session", target: "halo", sessionName: "explorer" });
		expect(result).toMatchObject({ kind: "refusal" });
		expect(h.host.wakes.map((frame) => frame.team)).toContain(team);

		const record = h.gateway.faults.sessionRecord(team);
		expect(record?.sessionLabel).toBe("explorer");
		await h.waitFor(async () => {
			const presence = (await h.phone.planesRead({})).planes.find((plane) => plane.name === "presence");
			return carries(presence?.payload, team) ? presence : undefined;
		}, "the asleep row in the roster");

		// A retry reattaches to the record instead of minting a second one.
		const again = await h.phone.value({ kind: "create_session", target: "halo", sessionName: "explorer" });
		expect(again.result).toMatchObject({ kind: "refusal" });
		expect(h.gateway.faults.sessionRecord(team)).toBe(record);
	});
});
