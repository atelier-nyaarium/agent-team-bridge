import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS, no .d.ts
import installThreadLinkRules from "../../android/app/src/main/assets/thread/markdown-link-rules.js";
// Both are plain classic <script>s in the browser (thread.html loads them before thread.js) that
// also assign to `module.exports` under Bun/Node, so the default imports work here same as any
// other CommonJS module. Testing against the REAL vendored markdown-it pins the actual rendered
// output, not a reimplementation of it.
// @ts-expect-error - plain JS, no .d.ts
import markdownit from "../../android/app/src/main/assets/thread/vendor/markdown-it.min.js";

function renderer() {
	const md = markdownit({ html: false, breaks: true, linkify: false });
	installThreadLinkRules(md);
	return md;
}

describe("installThreadLinkRules", () => {
	it("renders an https link as an ordinary anchor with its href intact", () => {
		const out = renderer().render("[Google](https://www.google.com)");
		expect(out).toContain('<a href="https://www.google.com">Google</a>');
		expect(out).not.toContain("link-unhandled");
	});

	it("renders a mailto link as an ordinary anchor", () => {
		const out = renderer().render("[mail me](mailto:a@b.example)");
		expect(out).toContain('<a href="mailto:a@b.example">mail me</a>');
		expect(out).not.toContain("link-unhandled");
	});

	it("renders a file: link as an inert red link - no href, target in data-href", () => {
		const out = renderer().render("[hosts](file:///etc/hosts)");
		// The space-prefixed form: `data-href="file..."` must not count as a real href.
		expect(out).not.toContain(' href="file');
		expect(out).toContain('data-href="file:///etc/hosts"');
		expect(out).toContain('class="link-unhandled"');
		expect(out).toContain(">hosts</a>");
	});

	it("renders a future custom protocol the same inert way", () => {
		const out = renderer().render("[ref](hostfile://project/src/main.ts)");
		expect(out).not.toContain(' href="hostfile');
		expect(out).toContain('data-href="hostfile://project/src/main.ts"');
		expect(out).toContain("link-unhandled");
	});

	it("treats a bare relative path link as unhandled rather than navigable", () => {
		const out = renderer().render("[readme](docs/readme.md)");
		expect(out).not.toContain(' href="docs/readme.md"');
		expect(out).toContain('data-href="docs/readme.md"');
		expect(out).toContain("link-unhandled");
	});

	it("refuses the in-page execution vectors outright - raw text, not even an inert anchor", () => {
		for (const url of ["javascript:alert(1)", "vbscript:x", "data:text/html;base64,PGI+"]) {
			const out = renderer().render(`[x](${url})`);
			expect(out).not.toContain("<a");
			expect(out).not.toContain("data-href");
		}
	});

	it("still lets a data:image inline image render", () => {
		const out = renderer().render("![dot](data:image/png;base64,iVBORw0KGgo=)");
		expect(out).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
	});

	it("a scheme that merely starts with a standard prefix does not pass as standard", () => {
		const out = renderer().render("[x](https-fake://evil)");
		expect(out).not.toContain(' href="https-fake');
		expect(out).toContain("link-unhandled");
	});
});

describe("a scheme a plugin claims", () => {
	function renderWith(schemes: string[], body: string): string {
		const md = markdownit();
		installThreadLinkRules(md, { value: schemes });
		return md.render(body);
	}

	it("renders as a live link rather than a broken one", () => {
		const html = renderWith(["ref:"], "See [add](ref://src/cart.ts:Cart:add).");

		expect(html).toContain("link-handled");
		expect(html).not.toContain("link-unhandled");
	});

	// The scheme rides along as its own class so a plugin can style its links (the references chip's
	// icon) without the renderer learning what any scheme means.
	it("stamps the claimed scheme as a class, so styling stays per-plugin", () => {
		const html = renderWith(["ref:"], "See [add](ref://src/cart.ts:Cart:add).");

		expect(html).toContain("link-scheme-ref");
	});

	it("gives an unclaimed scheme no per-scheme class to style", () => {
		expect(renderWith(["ref:"], "[a](file:///etc/hosts)")).not.toContain("link-scheme-");
	});

	it("stays inert, because only the JS tap path can see which row it sits in", () => {
		const html = renderWith(["ref:"], "See [add](ref://src/cart.ts:Cart:add).");

		// Deliberately a regex: `data-href=` contains the substring `href=`, so a plain contains
		// check would pass on an anchor that still carried a real href.
		expect(html).not.toMatch(/<a[^>]*\shref=/);
		expect(html).toContain('data-href="ref://src/cart.ts:Cart:add"');
	});

	it("falls back to the unhandled tier when nothing claims the scheme", () => {
		const html = renderWith([], "See [add](ref://src/cart.ts:Cart:add).");

		expect(html).toContain('class="link-unhandled"');
	});

	it("leaves standard schemes as ordinary anchors", () => {
		const html = renderWith(["ref:"], "See [docs](https://example.com).");

		expect(html).toContain('href="https://example.com"');
		expect(html).not.toContain("data-href");
	});

	it("matches the scheme case-insensitively, since a destination may be spelled either way", () => {
		expect(renderWith(["ref:"], "[a](REF://src/a.ts)")).toContain("link-handled");
	});

	it("works with no scheme list at all, which is the state before any plugin loads", () => {
		const md = markdownit();
		installThreadLinkRules(md);

		expect(md.render("[a](ref://src/a.ts)")).toContain('class="link-unhandled"');
	});
});
