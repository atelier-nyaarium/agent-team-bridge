import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldVersionedList } from "../shared/versioned-list.js";

type Entry = { id: string; revision: number };
type Vector = {
	name: string;
	held: { revision: number; entries: Entry[] };
	incoming: { revision: number; since: number; entries: Entry[] };
	expected: { kind: string; revision?: number; entries?: Entry[] };
};

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/versioned-list/vectors.json"), "utf8"),
) as { cases: Vector[] };

describe("versioned list fold", () => {
	for (const vector of vectors.cases) {
		it(vector.name, () => {
			const fold = foldVersionedList(vector.held, vector.incoming, {
				id: (entry) => entry.id,
				revision: (entry) => entry.revision,
			});
			expect(fold.kind).toBe(vector.expected.kind);
			if (fold.kind === "apply") {
				expect(fold.revision).toBe(vector.expected.revision);
				expect(fold.entries).toEqual(vector.expected.entries);
			}
		});
	}
});
