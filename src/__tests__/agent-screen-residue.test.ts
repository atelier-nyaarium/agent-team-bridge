import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One owner for "where does the rule boundary sit", in each language.
 *
 * The corpus next door proves BEHAVIOUR; it cannot prove OWNERSHIP. Before this refactor the module
 * hand-rolled the boundary search three times in TypeScript and twice in Kotlin, and the copies had
 * already drifted: `isAgentWorking` fell back to the last two lines when no rule existed while
 * `isLoggedOut` did not, so its `slice(lastRule + 1)` with lastRule at -1 read the ENTIRE screen. Both
 * copies passed every test that existed. A fourth copy added tomorrow would too.
 *
 * So this sweeps for the shape rather than the outcome. It is in the TS suite deliberately: the Kotlin
 * tests only run after merge (`main-push.yml`), so a Kotlin-side assertion could not block a PR, while
 * this can - and it is the Kotlin file it is most worried about, since nothing else holds the twin to
 * the same structure.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const TS_MODULE = path.join(REPO_ROOT, "src", "shared", "agent-screen.ts");
const KT_MODULE = path.join(
	REPO_ROOT,
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
	"AgentScreen.kt",
);

/** Source with comments stripped, so prose ABOUT the old shape is not read as the shape returning. */
function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
}

describe("agent-screen: the rule boundary has one owner per language", () => {
	it("has both modules to sweep", () => {
		for (const f of [TS_MODULE, KT_MODULE]) expect(fs.existsSync(f), f).toBe(true);
	});

	it("TypeScript: the primitive exists and the readers go through it", () => {
		const ts = code(TS_MODULE);
		expect(ts).toMatch(/function afterRuleRun\(/);
		expect(ts).toMatch(/function footerRegion\(/);
		// Positive control: a sweep that matched nothing would pass vacuously.
		expect((ts.match(/afterRuleRun\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
	});

	it("TypeScript: a marker names its region and never slices one", () => {
		// Two occurrences each: the definition, and the one call inside paneHas. A reader slicing for
		// itself makes three, so this pins the number rather than a floor.
		const ts = code(TS_MODULE);
		expect(ts).toMatch(/function paneHas\(/);
		expect((ts.match(/footerRegion\(/g) ?? []).length, "footerRegion has one caller").toBe(2);
		expect((ts.match(/statusRegion\(/g) ?? []).length, "statusRegion has one caller").toBe(2);
		// And the markers do reach it: a paneHas nobody called would satisfy the counts above.
		expect((ts.match(/paneHas\(/g) ?? []).length, "markers go through paneHas").toBeGreaterThanOrEqual(4);
	});

	it("TypeScript: nobody hand-rolls the old lastRule search", () => {
		const ts = code(TS_MODULE);
		// The exact shape that drifted. Any reintroduction is a second owner.
		expect(ts).not.toMatch(/findLastIndex/);
		expect(ts).not.toMatch(/lastRule/);
		// `slice(x + 1)` off a rule index is the specific bug: at -1 it hands over the whole screen.
		expect(ts).not.toMatch(/slice\(\s*lastRule/);
	});

	it("Kotlin: the twin has the same primitive and no hand-rolled search", () => {
		const kt = code(KT_MODULE);
		expect(kt).toMatch(/fun afterRuleRun\(/);
		expect(kt).toMatch(/fun footerRegion\(/);
		expect((kt.match(/afterRuleRun\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
		expect(kt).not.toMatch(/indexOfLast/);
		expect(kt).not.toMatch(/lastRule/);
	});

	it("Kotlin: the twin routes markers through the same one owner", () => {
		const kt = code(KT_MODULE);
		expect(kt).toMatch(/fun paneHas\(/);
		expect((kt.match(/footerRegion\(/g) ?? []).length, "footerRegion has one caller").toBe(2);
		expect((kt.match(/statusRegion\(/g) ?? []).length, "statusRegion has one caller").toBe(2);
		expect((kt.match(/paneHas\(/g) ?? []).length, "markers go through paneHas").toBeGreaterThanOrEqual(4);
	});

	it("both languages scope the auth notice the same way", () => {
		// One marker per slice, anchored only in the status one. Dropping either half stops detecting
		// one of the two layouts the notice renders in.
		for (const [name, src] of [
			["TypeScript", code(TS_MODULE)],
			["Kotlin", code(KT_MODULE)],
		] as const) {
			expect(src, `${name} keeps the unanchored toolbar rule`).toMatch(/Not logged in\|Run \/login/);
			expect(src, `${name} anchors the status rule`).toMatch(/\^\$?\{?SPACE\}?\*\(\?:Not logged in/);
		}
	});

	it("neither language matches whitespace with a shorthand class", () => {
		// JS \s matches U+00A0 and the JVM's default does not, and the Windows build emits U+00A0 right
		// after the composer glyph. A shorthand here is a silent cross-language divergence on a real
		// frame, so both sides spell the set out.
		//
		// ONE backslash in the pattern, matching one in the source. A regex literal writes `\s` and a
		// string-built regex writes `\\s`, and this catches both because the second contains the first.
		// It was `\\\\s` first, which matched only the string form - so the literal form, the one that
		// is easier to write by accident, would have sailed through the guard.
		const shorthand = /\\s[*+]/;
		expect(shorthand.test(String.raw`Regex("^\s+")`), "the guard must catch a regex literal").toBe(true);
		expect(shorthand.test(String.raw`"^\\s+"`), "the guard must catch a string-built regex").toBe(true);
		for (const [name, src] of [
			["TypeScript", code(TS_MODULE)],
			["Kotlin", code(KT_MODULE)],
		] as const) {
			expect(src, `${name} must not use \\s in a pane matcher`).not.toMatch(shorthand);
		}
	});

	it("limitNotice borrows the primitive rather than re-finding rules itself", () => {
		// It keeps its own SEARCH (it needs the lowest divider carrying both signals, not the last
		// toolbar rule), so the footerRegion count above cannot speak for it. What it must not do is
		// re-derive where a rule ends.
		for (const [name, src] of [
			["TypeScript", code(TS_MODULE)],
			["Kotlin", code(KT_MODULE)],
		] as const) {
			expect(
				(src.match(/afterRuleRun\(/g) ?? []).length,
				`${name} uses the primitive throughout`,
			).toBeGreaterThanOrEqual(4);
		}
	});

	it("both languages carry both composer glyphs", () => {
		// The Windows build draws U+003E, Linux U+276F. Losing either one silently halves the support.
		// Spelled differently per language on purpose - TS uses the literal, Kotlin the \u escape - so
		// each is matched in its own dialect rather than forcing one file to write the other's form.
		expect(code(TS_MODULE), "TypeScript glyph class").toMatch(/\[❯>\]/);
		expect(code(KT_MODULE), "Kotlin glyph class").toMatch(/\[\\\\u276F>\]/);
	});
});
