import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * Every `var(--x)` in the thread stylesheet must name a variable the stylesheet defines.
 *
 * An undefined custom property is not a CSS error. The declaration is simply dropped, so the element
 * silently keeps whatever it inherited. `a.link-handled` referenced a `--accent` that never existed,
 * and because a claimed link deliberately carries no href, nothing else styled it either: every ref
 * link in every message rendered as plain prose, with no way to tell it was tappable. Nothing failed,
 * nothing logged, and it took a screenshot from the owner's phone to see it.
 */
const THREAD_CSS = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"assets",
	"thread",
	"thread.css",
);

/** Custom properties the stylesheet declares, e.g. `--link: #0969da;`. */
function declared(css: string): Set<string> {
	return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
}

/** Custom properties the stylesheet reads, paired with whether the read supplies a fallback. */
function referenced(css: string): { name: string; hasFallback: boolean }[] {
	return [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)].map((m) => ({
		name: m[1],
		hasFallback: m[2] === ",",
	}));
}

////////////////////////////////
//  Tests

describe("the thread stylesheet's custom properties", () => {
	it("only reads variables it also defines, so no declaration is silently dropped", () => {
		const css = fs.readFileSync(THREAD_CSS, "utf8");
		const defined = declared(css);
		const missing = referenced(css)
			.filter((r) => !r.hasFallback && !defined.has(r.name))
			.map((r) => r.name);

		expect([...new Set(missing)]).toEqual([]);
	});

	it("defines every theme variable in both the light and dark blocks", () => {
		// A variable defined only under `:root` renders light-theme colours on a dark background, and
		// one defined only under `html.dark` disappears in light. Both are silent.
		const css = fs.readFileSync(THREAD_CSS, "utf8");
		const light = declared(css.slice(css.indexOf(":root {"), css.indexOf("html.dark {")));
		const dark = declared(css.slice(css.indexOf("html.dark {"), css.indexOf("* {")));

		expect([...light].filter((v) => !dark.has(v))).toEqual([]);
		expect([...dark].filter((v) => !light.has(v))).toEqual([]);
	});
});
