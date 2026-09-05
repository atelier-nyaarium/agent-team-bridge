import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS, no .d.ts
import installThreadLinkRules from "../../android/app/src/main/assets/thread/markdown-link-rules.js";
// @ts-expect-error - plain JS, no .d.ts
import markdownit from "../../android/app/src/main/assets/thread/vendor/markdown-it.min.js";

type Anchor = { href: string | null; target: string | null; className: string; dataHref: string | null };

function render(body: string, schemes: string[] = []): string {
	const md = markdownit({ html: false, breaks: true, linkify: false });
	installThreadLinkRules(md, { value: schemes });
	return md.render(body);
}

function anchor(html: string): Anchor {
	const match = html.match(/<a\s([^>]+)>/);
	expect(match).not.toBeNull();
	const attrs = new Map<string, string>();
	for (const [, name, value] of match?.[1].matchAll(/([\w-]+)="([^"]*)"/g) ?? []) attrs.set(name, value);
	return {
		href: attrs.get("href") ?? null,
		target: attrs.get("target") ?? null,
		className: attrs.get("class") ?? "",
		dataHref: attrs.get("data-href") ?? null,
	};
}

describe("thread markdown links", () => {
	it.each([
		{ url: "https://example.com", href: "https://example.com", className: "", dataHref: null, live: true },
		{ url: "mailto:a@b.example", href: "mailto:a@b.example", className: "", dataHref: null, live: true },
		{
			url: "file:///etc/hosts",
			href: null,
			className: "link-unhandled",
			dataHref: "file:///etc/hosts",
			live: false,
		},
		{ url: "docs/readme.md", href: null, className: "link-unhandled", dataHref: "docs/readme.md", live: false },
		{
			url: "ref://src/a.ts",
			href: null,
			className: "link-handled link-scheme-ref",
			dataHref: "ref://src/a.ts",
			live: false,
		},
	])("maps $url to its link boundary", ({ url, href, className, dataHref, live }) => {
		const link = anchor(render(`[x](${url})`, ["ref:"]));
		expect(link).toEqual({ href, target: null, className, dataHref });
		expect(link.href !== null).toBe(live);
	});

	it("matches claimed schemes case-insensitively", () => {
		expect(anchor(render("[x](REF://src/a.ts)", ["ref:"]))).toEqual({
			href: null,
			target: null,
			className: "link-handled link-scheme-ref",
			dataHref: "REF://src/a.ts",
		});
	});

	it.each([
		"javascript:alert(1)",
		"vbscript:x",
		"data:text/html;base64,PGI+",
	])("refuses a blocked destination: %s", (url) => expect(render(`[x](${url})`)).not.toContain("<a"));

	it("keeps data images as image output", () => {
		expect(render("![dot](data:image/png;base64,iVBORw0KGgo=)")).toContain(
			'<img src="data:image/png;base64,iVBORw0KGgo="',
		);
	});

	it("leaves standard links live and other links inert", () => {
		expect(
			[anchor(render("[web](https://example.com)")), anchor(render("[file](file:///etc/hosts)"))].map(
				(link) => link.href !== null,
			),
		).toEqual([true, false]);
	});
});
