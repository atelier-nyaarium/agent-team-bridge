import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { limitNotice } from "../shared/agent-screen.js";

interface Vector {
	name: string;
	screen: string[];
	expect: { detail: string | null } | null;
}

const vectors: Vector[] = JSON.parse(
	readFileSync(new URL("../../tests/fixtures/limit-notice/vectors.json", import.meta.url), "utf8"),
).vectors;

// Panes are pinned to tmuxCore's TMUX_COLS, so wrapping is reproducible rather than incidental.
const COLS = 53;
const rule = (ch = "─") => ch.repeat(COLS);
const CANCEL = "Stop and wait for limit to reset";

/** Word wrap, matching the renderer: it breaks between words and the break itself is not captured. */
function wrap(s: string): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of s.split(" ")) {
		if (row && `${row} ${word}`.length > COLS) {
			rows.push(row);
			row = word;
		} else {
			row = row ? `${row} ${word}` : word;
		}
	}
	if (row) rows.push(row);
	return rows;
}

/** The shape of a real limit dialog: transcript, divider, title, indented numbered menu. `gutter` is
 * the transcript sub-item glyph, which varies by item type, so every caller pins a different one. */
function dialog(headline: string, opts: { cancel?: string; gutter?: string; bottomBorder?: boolean } = {}) {
	const { cancel = CANCEL, gutter = "└", bottomBorder = false } = opts;
	return [
		"● an earlier turn said something",
		"",
		"←  switchboard: This is the initial bridge handshake. Reply",
		...wrap(`  ${gutter}   ${headline}`),
		rule("━"),
		"   What do you want to do?",
		"",
		` ❯ 1. ${cancel}`,
		"   2. Switch to usage credits",
		...(bottomBorder ? [rule("━")] : []),
		"   Enter to confirm · Esc to cancel",
	].join("\n");
}

/** An ordinary idle composer: titled top border, prompt, solid bottom border, toolbar. */
function composer(...transcript: string[]) {
	return [
		...transcript,
		"",
		`${"─".repeat(16)} Designing session limit sentinel regex ──`,
		"❯ ",
		rule(),
		"   ⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts",
	].join("\n");
}

describe("limitNotice", () => {
	// The same vectors the Kotlin twin reads, so neither runtime can drift from the other.
	describe("cross-runtime vectors", () => {
		it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
			const got = limitNotice(vector.screen.join("\n"));
			if (vector.expect === null) expect(got).toBeNull();
			else expect(got?.detail).toBe(vector.expect.detail);
		});
	});

	describe("detects a blocking dialog and reports the text after the dot", () => {
		it("reads the weekly limit exactly as the console showed it", () => {
			expect(limitNotice(dialog("You've hit your weekly limit · resets 5pm"))).toEqual({
				headline: "└   You've hit your weekly limit · resets 5pm",
				detail: "resets 5pm",
			});
		});

		it("reads 'reached' as well as 'hit'", () => {
			expect(limitNotice(dialog("You've reached your weekly limit · resets 9am"))?.detail).toBe("resets 9am");
		});

		it("reads a name that does not exist yet, since no name is enumerated", () => {
			expect(limitNotice(dialog("You've hit your quarterly widget allowance · resets never"))?.detail).toBe(
				"resets never",
			);
		});

		it("reports a null detail when the headline carries no dot", () => {
			expect(limitNotice(dialog("You've hit your cap"))?.detail).toBeNull();
		});

		it("rejoins a headline that wrapped, so a suffix on the continuation row survives", () => {
			const long =
				"You've hit your usage credit limit · run /usage-credits to raise it, or visit claude.ai/admin";
			expect(wrap(`  └   ${long}`).length).toBeGreaterThan(1);
			expect(limitNotice(dialog(long))?.detail).toBe("run /usage-credits to raise it, or visit claude.ai/admin");
		});

		it.each(["└", "⏿", "●", " "])("does not depend on the gutter glyph (%j)", (gutter) => {
			expect(limitNotice(dialog("You've hit your weekly limit · resets 5pm", { gutter }))).not.toBeNull();
		});

		it("finds the divider even when the dialog draws its own bottom border", () => {
			const screen = dialog("You've hit your weekly limit · resets 5pm", { bottomBorder: true });
			expect(limitNotice(screen)?.detail).toBe("resets 5pm");
		});

		it.each([
			"You're out of usage credits · add funds to continue",
			"Your seat type doesn't include usage credits",
			"Your usage allocation has been disabled by your admin",
			"This service is disabled for your org",
		])("detects the non-templated blocking notice %j", (headline) => {
			expect(limitNotice(dialog(headline))).not.toBeNull();
		});
	});

	describe("the dialog is the signal, so a missing headline costs only the detail", () => {
		it.each([
			"You've used 90% of your weekly limit",
			"You're close to your usage limit",
			"You're now using usage credits · Your weekly limit resets Monday",
			"Now using extra usage",
		])("still blocks with no detail when the line above is only %j", (line) => {
			// These are warning and transition notices, not limit headlines. The dialog below still
			// holds the pane, so the session is blocked; the line above simply says nothing about why.
			expect(limitNotice(dialog(line))).toEqual({ headline: null, detail: null });
		});

		it("blocks with no detail when the headline has scrolled off entirely", () => {
			const screen = ["● nothing relevant", rule("━"), " ❯ 1. Stop and wait for limit to reset"].join("\n");
			expect(limitNotice(screen)).toEqual({ headline: null, detail: null });
		});

		it("reads a block-element divider, which is what the dialog actually draws", () => {
			// U+2594, not box drawing. A Box-Drawing-only range finds no rule at all here.
			const screen = ["● earlier output", "▔".repeat(58), " ❯ 1. Stop and wait for limit to reset"].join("\n");
			expect(limitNotice(screen)).not.toBeNull();
		});
	});

	describe("stays silent when no limit dialog is holding the pane", () => {
		it("ignores a dialog whose cancel choice collapsed to a bare Stop", () => {
			const screen = dialog("You've hit your session limit · resets 3pm", { cancel: "Stop" });
			expect(limitNotice(screen)).toBeNull();
		});

		it("ignores a screen with no rule at all", () => {
			expect(limitNotice("You've hit your weekly limit · resets 5pm")).toBeNull();
		});
	});

	describe("stays silent on transcript text, which is where the headline also lives", () => {
		it("clears once the choice is answered and the composer returns", () => {
			const screen = composer("  └   You've hit your weekly limit · resets 5pm");
			expect(limitNotice(screen)).toBeNull();
		});

		it("ignores a session quoting the wording while discussing it", () => {
			const screen = composer(
				'● I tested it against "You\'ve hit your weekly limit" and it',
				'  matched, yielding "resets 5pm" after the dot.',
			);
			expect(limitNotice(screen)).toBeNull();
		});

		it("ignores quoted wording sitting directly above an unrelated dialog", () => {
			const screen = [
				'● I tested it against "You\'ve hit your weekly limit" and it',
				'  matched, yielding "resets 5pm" after the dot.',
				rule("━"),
				"   Bash command wants to run",
				"",
				" ❯ 1. Yes",
				"   2. No, and tell Claude what to do differently",
			].join("\n");
			expect(limitNotice(screen)).toBeNull();
		});
	});
});
