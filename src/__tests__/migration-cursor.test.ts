import { describe, expect, it } from "vitest";
import { mayConsume, type SyncCursor, translateCursor } from "../shared/migration-cursor.js";
import type { CursorMapEntry } from "../shared/schemasMigration.js";

const map: CursorMapEntry[] = [
	{ oldEpoch: 4, oldSeq: 3, epoch: 7, seq: 1 },
	{ oldEpoch: 4, oldSeq: 9, epoch: 7, seq: 2 },
];

const at = (epoch: number, seq: number): SyncCursor => ({ epoch, seq });

describe("migration cursor translation", () => {
	it("leaves a cursor already on the current epoch alone", () => {
		expect(translateCursor(at(7, 2), 7, map)).toEqual({ kind: "current" });
	});

	it("translates an old coordinate to the one the Router holds", () => {
		expect(translateCursor(at(4, 9), 7, map)).toEqual({ kind: "translated", cursor: { epoch: 7, seq: 2 } });
	});

	// Reading on would skip whatever sat between; starting over would re-deliver everything already
	// read. Neither is safe, so it refuses and the phone asks again.
	it("refuses a coordinate the map does not cover", () => {
		expect(translateCursor(at(4, 5), 7, map)).toEqual({ kind: "unmapped" });
	});

	// Repeatable: the phone may die between hearing the answer and committing it, and must be able
	// to ask again and get the same answer.
	it("answers the same old cursor identically however often it is asked", () => {
		const first = translateCursor(at(4, 3), 7, map);

		expect(translateCursor(at(4, 3), 7, map)).toEqual(first);
		expect(translateCursor(at(4, 3), 7, map)).toEqual(first);
	});

	// The ordering is the load-bearing part: a kill between the welcome and the commit must replay
	// to the same cursor rather than ack rows nobody was handed.
	it("takes no rows on an old cursor until the translation is committed", () => {
		const base = { welcomed: true, cursorEpoch: 4, migrationEpoch: 7 };

		expect(mayConsume({ ...base, committed: false })).toBe(false);
		expect(mayConsume({ ...base, committed: true })).toBe(true);
	});

	it("takes no rows before the welcome, committed or not", () => {
		expect(mayConsume({ welcomed: false, cursorEpoch: 7, migrationEpoch: 7, committed: true })).toBe(false);
	});

	it("takes rows straight away once the cursor is on the current epoch", () => {
		expect(mayConsume({ welcomed: true, cursorEpoch: 7, migrationEpoch: 7, committed: false })).toBe(true);
	});
});
