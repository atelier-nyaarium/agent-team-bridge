// Breaks CommonMark's blockquote "lazy continuation": by spec, a plain text line right after a `>`
// quoted line (no blank line between them) is absorbed into the SAME blockquote paragraph rather
// than starting its own block - correct per spec, but not what a chat message typically means by
// two consecutive lines. Inserts a blank line so the second line renders as its own block instead.
// Skips fenced code blocks entirely (toggled by any ``` or ~~~ line) so a pasted diff/snippet
// containing a line that happens to start with ">" is never touched.
//
// Pure/dependency-free (no DOM, no markdown-it) so it is unit-testable directly - see
// src/__tests__/thread-markdown-lazy-blockquote.test.ts. Loaded as a plain classic <script> before
// thread.js (see thread.html), which is why this uses a small universal (UMD-style) export rather
// than ESM import/export syntax - a classic script cannot contain `export`.
(function (root, factory) {
	const fn = factory();
	// Checked in this order deliberately: Bun defines a synthetic `module` object even for a
	// genuine ESM file (confirmed empirically - unlike plain Node, where `module` is truly
	// undefined outside CommonJS), so `typeof module` alone cannot tell a browser classic-script
	// load apart from a Bun-run test import. `window` only ever exists in the former.
	if (typeof window !== "undefined") root.breakLazyBlockquoteContinuations = fn;
	if (typeof module === "object" && module.exports) module.exports = fn;
})(globalThis, function () {
	return function breakLazyBlockquoteContinuations(text) {
		const lines = text.split("\n");
		const out = [];
		let prevWasQuote = false;
		let inFence = false;
		for (const line of lines) {
			if (/^ {0,3}(```|~~~)/.test(line)) {
				inFence = !inFence;
				out.push(line);
				prevWasQuote = false;
				continue;
			}
			if (inFence) {
				out.push(line);
				continue;
			}
			const isQuote = /^ {0,3}>/.test(line);
			if (prevWasQuote && !isQuote && line.trim() !== "") out.push("");
			out.push(line);
			prevWasQuote = isQuote;
		}
		return out.join("\n");
	};
});
