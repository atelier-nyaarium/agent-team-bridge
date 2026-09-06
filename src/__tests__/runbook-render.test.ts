import { describe, expect, it } from "vitest";
import { renderRunbook } from "../shared/runbook-grammar.js";
import type { RunbookParameter } from "../shared/schemasRunbook.js";

const parameter = (name: string, over: Partial<RunbookParameter> = {}): RunbookParameter => ({
	name,
	label: name,
	kind: "text",
	...over,
});

const render = (body: string, parameters: RunbookParameter[], values: Record<string, string>) =>
	renderRunbook(body, parameters, values);

describe("rendering a runbook", () => {
	it("fills every mention of a parameter, not just the first", () => {
		const out = render("bump {{level}}, tag {{level}}", [parameter("level")], { level: "minor" });
		expect(out).toEqual({ ok: true, text: "bump minor, tag minor" });
	});

	it("falls back to a default, and takes a body with nothing to fill", () => {
		expect(render("go {{env}}", [parameter("env", { default: "staging" })], {})).toEqual({
			ok: true,
			text: "go staging",
		});
		expect(render("just do it", [], {})).toEqual({ ok: true, text: "just do it" });
	});

	it("refuses a missing value by name rather than shipping the placeholder as instruction", () => {
		const out = render("bump {{level}} for {{repo}}", [parameter("level"), parameter("repo")], { level: "minor" });
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.reason).toContain("repo");
	});

	it("refuses a choice the runbook does not offer", () => {
		const env = parameter("env", { kind: "choice", options: ["staging", "prod"] });
		expect(render("go {{env}}", [env], { env: "prod" }).ok).toBe(true);
		expect(render("go {{env}}", [env], { env: "production" }).ok).toBe(false);
	});

	it("refuses a value for a parameter this runbook does not have", () => {
		const out = render("bump {{level}}", [parameter("level")], { level: "minor", tier: "gold" });
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.reason).toContain("tier");
	});

	it("refuses an output that reads as another placeholder, however it composed", () => {
		// The body and the value are each innocent; the braces meet only after substitution.
		expect(render("{{a}}{foo}}", [parameter("a")], { a: "{" }).ok).toBe(false);
		expect(render("set {{a}}", [parameter("a")], { a: "{{b}}" }).ok).toBe(false);
		expect(render("set {{a}}", [parameter("a")], { a: "plain" }).ok).toBe(true);
	});

	it("takes a value holding a bare opener, which composes nothing and stays prose", () => {
		const out = render("say {{a}}", [parameter("a")], { a: "use {{ to open one" });
		expect(out).toEqual({ ok: true, text: "say use {{ to open one" });
	});

	it("refuses a missing value even when its name is one every object answers to", () => {
		const out = render("call {{toString}}", [parameter("toString")], {});
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.reason).toContain("toString");
	});

	it("leaves a body's own braces alone, since prose about JSON is not a template", () => {
		const out = render('write {"a": {"b": {{n}}}}', [parameter("n")], { n: "1" });
		expect(out).toEqual({ ok: true, text: 'write {"a": {"b": 1}}' });
	});
});
