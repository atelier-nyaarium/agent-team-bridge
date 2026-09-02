import { describe, expect, it } from "vitest";
import { applyAnswer, nextFrame, type Sync } from "../gateway/router/presenceProtocol.js";
import type { PresenceRow } from "../shared/presence-identity.js";

const row = (team: string, status: PresenceRow["status"] = "available"): PresenceRow => ({
	team,
	gatewayId: "gateway",
	status,
	kind: "loose",
	queue_depth: 0,
});

const spawnPoints = { gatewayId: "gateway", hostSpawns: [] };

describe("presence protocol", () => {
	it("builds a baseline from the required state", () => {
		const frame = nextFrame({ at: "needsBaseline" }, 4, [row("one")], spawnPoints);
		expect(frame).toEqual({ at: "baseline", incarnation: 4, rows: [row("one")], spawnPoints });
	});

	it("commits a landed baseline snapshot", () => {
		const sync: Sync = { at: "needsBaseline" };
		const frame = nextFrame(sync, 4, [row("one")], spawnPoints);
		expect(applyAnswer(sync, frame!, { result: { ok: true } })).toEqual({
			at: "landed",
			sync: { at: "streaming", seq: 0, sent: new Map([["one", row("one")]]) },
		});
	});

	it("parks a refused baseline and retries an errored baseline", () => {
		const sync: Sync = { at: "needsBaseline" };
		const frame = nextFrame(sync, 4, [row("one")], spawnPoints)!;
		expect(applyAnswer(sync, frame, { result: { resync: true } })).toEqual({ at: "parked" });
		expect(applyAnswer(sync, frame, { error: "offline" })).toEqual({ at: "retry", sync });
	});

	it("keeps failed deltas pending and rebaselines on resync", () => {
		const sync: Sync = { at: "streaming", seq: 3, sent: new Map([["one", row("one")]]) };
		const frame = nextFrame(sync, 4, [row("one", "online")], spawnPoints)!;
		expect(applyAnswer(sync, frame, { result: { ok: false } })).toEqual({ at: "retry", sync });
		expect(applyAnswer(sync, frame, { result: { resync: true } })).toEqual({ at: "rebaseline" });
	});

	it("does not create a frame without an incarnation", () => {
		expect(nextFrame({ at: "needsBaseline" }, null, [row("one")], spawnPoints)).toBeNull();
	});
});
