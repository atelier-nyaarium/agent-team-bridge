// The code viewer for a tapped ref.
//
// ESCAPING CONTRACT, the one rule this file lives by: code reaches the DOM only through hljs's own
// escaped output, or through textContent. Every manifest-derived string (breadcrumb, filename,
// matcher, banner) goes in via textContent. Nothing here ever assigns innerHTML from data, because
// a snapshot is a copy of an arbitrary project file and a banner quotes text the agent wrote.
(function () {
	"use strict";

	const crumb = document.getElementById("crumb");
	const banner = document.getElementById("banner");
	const bannerText = document.getElementById("banner-text");
	const codeEl = document.getElementById("code");

	document.getElementById("banner-dismiss").addEventListener("click", () => {
		banner.hidden = true;
	});

	/** Highlight one line, falling back to plain text when hljs has no grammar or throws. */
	function highlight(text, language) {
		if (language && window.hljs && window.hljs.getLanguage(language)) {
			try {
				return window.hljs.highlight(text, { language: language, ignoreIllegals: true }).value;
			} catch (e) {
				/* fall through to escaped text */
			}
		}
		const span = document.createElement("span");
		span.textContent = text;
		return span.innerHTML;
	}

	/**
	 * Wrap a column range on an already-highlighted line.
	 *
	 * Walks TEXT NODES rather than slicing the HTML string, because hljs has rewritten the line into
	 * spans and any offset into the markup would land inside a tag. Columns count characters of the
	 * original line, which is exactly what the text nodes spell out in order.
	 */
	function markColumns(lineEl, from, to) {
		if (to <= from) return;
		const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
		let seen = 0;
		const edits = [];
		let node = walker.nextNode();
		while (node) {
			const start = seen;
			const end = seen + node.data.length;
			if (end > from && start < to) {
				edits.push({ node: node, from: Math.max(from - start, 0), to: Math.min(to - start, node.data.length) });
			}
			seen = end;
			node = walker.nextNode();
		}
		for (const edit of edits) {
			const text = edit.node.data;
			const mark = document.createElement("mark");
			mark.className = "span";
			mark.textContent = text.slice(edit.from, edit.to);
			const after = edit.node.splitText(edit.from);
			after.data = text.slice(edit.to);
			edit.node.parentNode.insertBefore(mark, after);
		}
	}

	function addGap(label) {
		const row = document.createElement("div");
		row.className = "line gap";
		const ln = document.createElement("div");
		ln.className = "ln";
		ln.textContent = "⋯";
		const src = document.createElement("div");
		src.className = "src";
		src.textContent = label;
		row.appendChild(ln);
		row.appendChild(src);
		codeEl.appendChild(row);
	}

	/**
	 * Render a payload.
	 *
	 * `segments` carry ORIGINAL-file line numbers even in snippet mode, so the gutter always shows
	 * where the code really lives rather than a position within the excerpt.
	 */
	window.refview = {
		setTheme(dark) {
			document.body.classList.toggle("dark", !!dark);
			document.getElementById("hljs-light").disabled = !!dark;
			document.getElementById("hljs-dark").disabled = !dark;
		},

		render(payload) {
			crumb.textContent = "";
			const path = document.createElement("strong");
			path.textContent = payload.refPath || "";
			crumb.appendChild(path);
			if (payload.label) {
				const label = document.createElement("span");
				label.textContent = "  " + payload.label;
				crumb.appendChild(label);
			}

			if (payload.notice) {
				bannerText.textContent = payload.notice;
				banner.hidden = false;
			}

			codeEl.textContent = "";
			const span = payload.span || null;
			let previousEnd = null;

			for (const segment of payload.segments || []) {
				if (previousEnd !== null && segment.startLine > previousEnd + 1) {
					addGap(segment.startLine - previousEnd - 1 + " lines hidden");
				}
				const lines = String(segment.text).split("\n");
				for (let i = 0; i < lines.length; i++) {
					const lineNumber = segment.startLine + i;
					const row = document.createElement("div");
					row.className = "line";
					if (lineNumber >= payload.startLine && lineNumber <= payload.endLine) row.classList.add("in-range");

					const ln = document.createElement("div");
					ln.className = "ln";
					ln.textContent = String(lineNumber);

					const src = document.createElement("div");
					src.className = "src";
					src.innerHTML = highlight(lines[i], payload.language);

					if (span && lineNumber >= span.startLine && lineNumber <= span.endLine) {
						const from = lineNumber === span.startLine ? span.startColumn : 0;
						const to = lineNumber === span.endLine ? span.endColumn : lines[i].length;
						markColumns(src, from, to);
					}

					row.appendChild(ln);
					row.appendChild(src);
					codeEl.appendChild(row);
					previousEnd = lineNumber;
				}
			}

			const first = codeEl.querySelector(".line.in-range");
			if (first) first.scrollIntoView({ block: "center" });
		},
	};

	if (window.Android && typeof window.Android.ready === "function") window.Android.ready();
})();
