import { describe, expect, it } from "vitest";
import { parseBody, placeholdersOf } from "../shared/runbook-grammar.js";
import { type Runbook, type RunbookParameter, runbookRefusal } from "../shared/schemasRunbook.js";

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

describe("the body grammar", () => {
	it("names each parameter once, in the order the body first mentions it", () => {
		expect(placeholdersOf("bump {{level}} then tag {{level}} for {{repo}}")).toEqual(["level", "repo"]);
		expect(placeholdersOf("{{ padded }} and {{tight}}")).toEqual(["padded", "tight"]);
		expect(placeholdersOf("{single} brace")).toEqual([]);
	});

	it("splits a body into the literals and the blanks a render fills", () => {
		expect(parseBody("cut {{level}} now")).toEqual({
			ok: true,
			tokens: [
				{ kind: "literal", text: "cut " },
				{ kind: "placeholder", name: "level" },
				{ kind: "literal", text: " now" },
			],
		});
	});

	it("refuses an opener that names no parameter, rather than passing it off as literal", () => {
		for (const body of ["{{a{{b}}}}", "cut {{level", "{{2fast}}", "{{ }}"]) {
			expect(parseBody(body).ok).toBe(false);
		}
		// Prose closing nested JSON opens nothing.
		expect(parseBody('the config reads {"a": {"b": 1}}').ok).toBe(true);
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

	it("carries the grammar's own refusal rather than reading a half-parsed body", () => {
		expect(runbookRefusal(runbook("{{a{{b}}}}", [parameter("b")]))).toContain("{{");
	});

	it("refuses a filled value that opens a placeholder, so rendering cannot recurse", () => {
		const fill = (over: Partial<RunbookParameter>) =>
			runbookRefusal(runbook("go {{env}}", [parameter("env", over)]));
		expect(fill({ default: "{{other}}" })).toContain("opens");
		expect(fill({ kind: "choice", options: ["prod", "{{other}}"] })).toContain("opens");
		expect(fill({ kind: "choice", options: ["prod", "staging"] })).toBeNull();
		// A closing brace opens nothing, as in a body.
		expect(fill({ kind: "choice", options: ["}}"] })).toBeNull();
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
