import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBody, placeholdersOf } from "../shared/runbook-grammar.js";

type Vector = { name: string; body: string; names: string[] | null };

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/runbook-grammar/vectors.json"), "utf8"),
) as { cases: Vector[] };

describe("runbook placeholder scan, against the shared corpus", () => {
	for (const vector of vectors.cases) {
		it(vector.name, () => {
			const parsed = parseBody(vector.body);
			expect(parsed.ok).toBe(vector.names !== null);
			if (vector.names !== null) expect(placeholdersOf(vector.body)).toEqual(vector.names);
		});
	}
});
