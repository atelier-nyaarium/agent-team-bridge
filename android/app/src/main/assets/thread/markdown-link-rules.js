// Two-tier link rendering for the thread renderer:
//
//   Standard schemes (http/https/mailto) render as ordinary tappable anchors - tapping navigates,
//   the WebView layer intercepts, and the app's scheme dispatcher opens them.
//
//   Every other scheme (file:, a future custom protocol, a bare relative path) still RENDERS as a
//   link, but INERT and visually distinct (class "link-unhandled", styled red in thread.css): the
//   href attribute is removed entirely - the WebView cannot navigate what has no href, so even a
//   javascript: URL is dead markup - and the target rides in data-href, which the delegated tap
//   listener in thread.js feeds to the copy-only link menu.
//
//   The only URLs refused outright at parse time (rendered as raw text, no anchor at all) are the
//   in-page execution vectors (javascript:/vbscript:) and non-image data: blobs; data:image/ stays
//   parseable so inline demo images keep working.
//
// Takes only the markdown-it instance, so it is unit-testable against the real vendored library -
// see src/__tests__/thread-markdown-link-rules.test.ts. Loaded as a plain classic <script> before
// thread.js (see thread.html), hence the small universal (UMD-style) export rather than ESM syntax.
(function (root, factory) {
	const fn = factory();
	// Checked in this order deliberately: Bun defines a synthetic `module` object even for a
	// genuine ESM file (unlike plain Node), so `typeof module` alone cannot tell a browser
	// classic-script load apart from a Bun-run test import. `window` only ever exists in the former.
	if (typeof window !== "undefined") root.installThreadLinkRules = fn;
	if (typeof module === "object" && module.exports) module.exports = fn;
})(globalThis, function () {
	const STANDARD_LINK = /^(https?:|mailto:)/i;
	const BLOCKED_LINK = /^(javascript:|vbscript:|data:(?!image\/))/i;

	return function installThreadLinkRules(md) {
		md.validateLink = (url) => !BLOCKED_LINK.test(url.trim());

		const defaultLinkOpen =
			md.renderer.rules.link_open ||
			function (tokens, idx, options, env, self) {
				return self.renderToken(tokens, idx, options);
			};
		md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
			const token = tokens[idx];
			const href = (token.attrGet("href") || "").trim();
			if (!STANDARD_LINK.test(href)) {
				const i = token.attrIndex("href");
				if (i >= 0) token.attrs.splice(i, 1);
				token.attrSet("data-href", href);
				token.attrJoin("class", "link-unhandled");
			}
			return defaultLinkOpen(tokens, idx, options, env, self);
		};
	};
});
