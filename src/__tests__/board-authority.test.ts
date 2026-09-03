import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_REFUSALS } from "../shared/board-authority.js";

describe("board refusal vocabulary", () => {
	it("matches the shared fixture", () => {
		const fixture = JSON.parse(fs.readFileSync("tests/fixtures/board-authority/vocabulary.json", "utf8")) as {
			refusals: string[];
		};
		expect([...BOARD_REFUSALS]).toEqual(fixture.refusals);
	});
});
