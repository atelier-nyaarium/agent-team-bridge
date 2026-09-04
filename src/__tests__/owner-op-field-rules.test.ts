import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OwnerOpSchema } from "../shared/schemasInbox.js";

type FieldRule = {
	pattern: string;
	maxLength?: number;
	valid: string;
	violation: string;
};

const rules = JSON.parse(
	readFileSync(new URL("../../tests/fixtures/owner-op/field-rules.json", import.meta.url), "utf8"),
) as { fields: Record<string, FieldRule> };
const vectors = JSON.parse(
	readFileSync(new URL("../../tests/fixtures/owner-op/vectors.json", import.meta.url), "utf8"),
) as { ownerOp: { value: Record<string, unknown>; signature: string } };
const ownerOp = { ...vectors.ownerOp.value, signature: vectors.ownerOp.signature };
const candidates = [
	"550e8400-e29b-41d4-a716-446655440000",
	"ABCDEF0123456789",
	"YWJjZA==",
	"YWJjZA",
	"////++++",
	"plain/with/slash",
	"line\nbreak",
	"line\rbreak",
	"",
	"a",
	"a".repeat(1024),
	"has space",
	"é",
	...new Set(
		Object.values(rules.fields).flatMap((rule) =>
			rule.maxLength === undefined ? [] : ["a".repeat(rule.maxLength), "a".repeat(rule.maxLength + 1)],
		),
	),
];

describe("OwnerOp field rules", () => {
	it("matches the Router schema for every fixture rule", () => {
		expect(OwnerOpSchema.safeParse(ownerOp).success).toBe(true);

		for (const [field, rule] of Object.entries(rules.fields)) {
			for (const candidate of candidates) {
				const ruleAccepts =
					candidate !== "" &&
					new RegExp(rule.pattern).test(candidate) &&
					(rule.maxLength === undefined || candidate.length <= rule.maxLength);
				const schemaAccepts = OwnerOpSchema.safeParse({ ...ownerOp, [field]: candidate }).success;

				expect(schemaAccepts, `${field}: ${JSON.stringify(candidate)}`).toBe(ruleAccepts);
			}
		}
	});
});
