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
const ASSETS = path.join(import.meta.dirname, "..", "..", "android", "app", "src", "main", "assets");

const THREAD_CSS = path.join(ASSETS, "thread", "thread.css");

/** Each bundled page as (name, html, css), for the checks that span both files. */
const PAGES = [
	["thread", path.join(ASSETS, "thread", "thread.html"), THREAD_CSS],
	["refview", path.join(ASSETS, "refview", "refview.html"), path.join(ASSETS, "refview", "refview.css")],
] as const;

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

	// An id selector that sets `display` outranks the browser's own `[hidden] { display: none }`, so an
	// element the page hides by attribute renders anyway. That is how the ref viewer's drift banner
	// came to show on EVERY reference, empty: pale enough to miss in the light theme, a solid amber bar
	// in dark. Any page that hides something by attribute needs the reset that wins.
	it.each(
		PAGES.filter(([, html]) => fs.readFileSync(html, "utf8").includes("hidden")),
	)("%s resets [hidden] so an id rule cannot un-hide an element", (_name, _html, cssPath) => {
		const css = fs.readFileSync(cssPath, "utf8").replace(/\s+/g, " ");

		expect(css).toContain("[hidden] { display: none !important; }");
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
