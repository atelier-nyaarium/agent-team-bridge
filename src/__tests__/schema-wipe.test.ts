import { describe, expect, it } from "vitest";
import { dueSchemaSteps, schemaVersionOf } from "../gateway/schemaWipe.js";

const STEPS = [
	{ version: 2, files: ["pending-jobs.json", "mailboxes.json"] },
	{ version: 3, files: ["mailboxes.json", "task-board.json"] },
];

describe("schema wipe steps", () => {
	it("runs only the steps past the sentinel, so a later bump never repeats an earlier wipe", () => {
		expect(dueSchemaSteps(0, STEPS).map((step) => step.version)).toEqual([2, 3]);
		expect(dueSchemaSteps(2, STEPS).map((step) => step.version)).toEqual([3]);
		expect(dueSchemaSteps(3, STEPS)).toEqual([]);
	});

	it("reads a missing or unreadable sentinel as a fresh directory", () => {
		expect(schemaVersionOf(null)).toBe(0);
		expect(schemaVersionOf("")).toBe(0);
		expect(schemaVersionOf("x")).toBe(0);
		expect(schemaVersionOf("2\n")).toBe(2);
	});
});
