import type { PresenceRow } from "../../shared/presence-identity.js";
import type { GatewaySpawnPoints } from "../../shared/types.js";

export type Sync =
	| { at: "needsBaseline" }
	| { at: "parked" }
	| { at: "streaming"; seq: number; sent: Map<string, PresenceRow> };

export type Frame =
	| { at: "baseline"; incarnation: number; rows: PresenceRow[]; spawnPoints: GatewaySpawnPoints }
	| {
			at: "delta";
			incarnation: number;
			seq: number;
			upserts: PresenceRow[];
			tombstones: string[];
			rows: PresenceRow[];
	  };

/** A transport error and a refused frame both arrive without `ok`, and both mean it did not land. */
export type PresenceAnswer = {
	error?: string;
	result?: unknown;
};

type PresenceResult = { ok?: boolean; resync?: boolean };

export type Verdict =
	| { at: "landed"; sync: Sync }
	| { at: "parked" }
	| { at: "retry"; sync: Sync }
	| { at: "rebaseline" };

const sameRow = (left: PresenceRow | undefined, right: PresenceRow): boolean =>
	JSON.stringify(left) === JSON.stringify(right);

export function nextFrame(
	sync: Sync,
	incarnation: number | null,
	rows: PresenceRow[],
	spawnPoints: GatewaySpawnPoints,
): Frame | null {
	if (incarnation === null) return null;
	if (sync.at === "needsBaseline") return { at: "baseline", incarnation, rows, spawnPoints };
	if (sync.at === "parked") return null;

	const current = new Map(rows.map((row) => [row.team, row]));
	const upserts = rows.filter((row) => !sameRow(sync.sent.get(row.team), row));
	const tombstones = [...sync.sent.keys()].filter((team) => !current.has(team));
	if (upserts.length === 0 && tombstones.length === 0) return null;
	return { at: "delta", incarnation, seq: sync.seq + 1, upserts, tombstones, rows };
}

/** No access to the sender, so an answer can never start a frame. */
export function applyAnswer(sync: Sync, frame: Frame, answer: PresenceAnswer): Verdict {
	const result = answer.result as PresenceResult | undefined;
	// Commits the snapshot that went on the wire, never a re-read: a row that changed during the
	// send was not delivered and must stay pending.
	if (result?.ok === true) {
		const sent = new Map(frame.rows.map((row) => [row.team, row]));
		return { at: "landed", sync: { at: "streaming", seq: frame.at === "baseline" ? 0 : frame.seq, sent } };
	}
	// A refused baseline waits for a cue; a refused delta asks for one. Anything else never landed.
	if (result?.resync !== true) return { at: "retry", sync };
	return frame.at === "baseline" ? { at: "parked" } : { at: "rebaseline" };
}
