import { describe, expect, it } from "vitest";
import {
	placeholderOccurrences,
	placeholdersOf,
	type Runbook,
	type RunbookParameter,
	runbookRefusal,
} from "../shared/schemasRunbook.js";

const parameter = (name: string, over: Partial<RunbookParameter> = {}): RunbookParameter => ({
	name,
	label: name,
	kind: "text",
	...over,
});

const runbook = (body: string, parameters: RunbookParameter[] = []): Runbook => ({
	id: "r1",
	name: "Release",
	body,
	parameters,
	revision: 1,
});

describe("runbook placeholders", () => {
	it("names each parameter once, in the order the body first mentions it", () => {
		expect(placeholdersOf("bump {{level}} then tag {{level}} for {{repo}}")).toEqual(["level", "repo"]);
		expect(placeholdersOf("{{ padded }} and {{tight}}")).toEqual(["padded", "tight"]);
		// Invalid forms: a lone brace pair, and a name starting with a digit.
		expect(placeholdersOf("{single} {{2fast}} literal")).toEqual([]);
	});

	it("reports every occurrence, not every name, so a renderer can substitute each", () => {
		expect(placeholderOccurrences("{{a}} {{a}}").map((o) => o.index)).toEqual([0, 6]);
		expect(placeholderOccurrences("{{ a }}")[0]).toEqual({ name: "a", index: 0, length: 7 });
	});
});

describe("runbook refusals", () => {
	it("takes a body whose placeholders and parameters agree", () => {
		expect(runbookRefusal(runbook("bump {{level}}", [parameter("level")]))).toBeNull();
		expect(runbookRefusal(runbook("nothing to fill"))).toBeNull();
	});

	it("refuses a placeholder and a parameter that do not answer each other", () => {
		expect(runbookRefusal(runbook("bump {{level}}"))).toContain("level");
		expect(runbookRefusal(runbook("bump it", [parameter("level")]))).toContain("never names it");
		expect(runbookRefusal(runbook("{{a}}", [parameter("a"), parameter("a")]))).toContain("twice");
	});

	it("refuses a brace that opens no placeholder, since a render would leave it behind", () => {
		expect(runbookRefusal(runbook("{{a{{b}}}}", [parameter("b")]))).toContain("{{");
		expect(runbookRefusal(runbook("cut {{level", [parameter("level")]))).toContain("{{");
		// Prose closing nested JSON is not a placeholder and stays allowed.
		expect(runbookRefusal(runbook('the config reads {"a": {"b": 1}}'))).toBeNull();
	});

	it("refuses a filled value that is itself a template, so rendering cannot recurse", () => {
		const fill = (over: Partial<RunbookParameter>) =>
			runbookRefusal(runbook("go {{env}}", [parameter("env", over)]));
		expect(fill({ default: "{{other}}" })).toContain("braces");
		expect(fill({ kind: "choice", options: ["prod", "{{other}}"] })).toContain("braces");
		expect(fill({ kind: "choice", options: ["prod", "staging"] })).toBeNull();
	});

	it("refuses a choice that cannot be chosen from", () => {
		const choice = (over: Partial<RunbookParameter>) =>
			runbookRefusal(runbook("go {{env}}", [parameter("env", { kind: "choice", ...over })]));
		expect(choice({ options: ["staging", "prod"] })).toBeNull();
		expect(choice({ options: ["staging"], default: "staging" })).toBeNull();
		expect(choice({})).toContain("no options");
		expect(choice({ options: ["a", "a"] })).toContain("repeats");
		expect(choice({ options: ["staging"], default: "prod" })).toContain("does not offer");
	});

	it("takes a body far past any size a form would offer, since the owner spends their own gateway", () => {
		const many = Array.from({ length: 64 }, (_, i) => `{{p${i}}}`).join(" ");
		const params = Array.from({ length: 64 }, (_, i) => parameter(`p${i}`));
		expect(runbookRefusal(runbook(`${"x".repeat(200_000)}${many}`, params))).toBeNull();
	});
});
