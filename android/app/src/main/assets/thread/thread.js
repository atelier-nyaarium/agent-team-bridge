"use strict";

// Renderer for one conversation thread. Kotlin drives it through window.thread:
//   thread.setMessages(messages)     full transcript replace
//   thread.appendMessages(messages)  append (or in-place update when an id repeats)
//   thread.setTheme(dark)            light/dark swap, re-themes hljs + mermaid
// Message shape: {id, role: "user"|"agent", from, at, body, files?: [{name, mime, src?}], status?}
// Markdown is semi-trusted: html stays off and links are protocol-allowlisted here;
// the WebView layer additionally blocks every non-appassets resource load.

(function () {
	const container = document.getElementById("messages");

	////////////////////////////////
	//  Markdown

	const md = window.markdownit({
		html: false,
		linkify: true,
		highlight: function (code, lang) {
			if (lang && window.hljs.getLanguage(lang)) {
				try {
					return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
				} catch (e) {
					/* fall through to escaped */
				}
			}
			return md.utils.escapeHtml(code);
		},
	});

	// http/https per plan; mailto is fetch-free and data:image lets the demo
	// fixture inline images without any network surface.
	const ALLOWED_LINK = /^(https?:|mailto:|data:image\/)/i;
	md.validateLink = (url) => ALLOWED_LINK.test(url.trim());

	// Label code fences with their language and divert ```mermaid fences to a
	// lazily rendered placeholder that keeps the source for fallback + re-theme.
	const defaultFence = md.renderer.rules.fence;
	md.renderer.rules.fence = function (tokens, idx, options, env, self) {
		const token = tokens[idx];
		const lang = (token.info || "").trim().split(/\s+/)[0];
		if (lang === "mermaid") {
			return (
				'<div class="mermaid-block pending"><pre class="mermaid-src">' +
				md.utils.escapeHtml(token.content) +
				"</pre></div>"
			);
		}
		const rendered = defaultFence(tokens, idx, options, env, self);
		if (!lang) return rendered;
		return (
			'<div class="code-block"><span class="code-lang">' +
			md.utils.escapeHtml(lang) +
			"</span>" +
			rendered +
			"</div>"
		);
	};

	////////////////////////////////
	//  Mermaid (lazy, render once, re-render on theme change)

	let mermaidSeq = 0;

	function initMermaid() {
		window.mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
		});
	}

	const MERMAID_TIMEOUT_MS = 8000;

	async function renderMermaid(block) {
		const src = block.querySelector(".mermaid-src");
		if (!src) return;
		const code = src.textContent;
		const id = "mm-" + ++mermaidSeq;
		try {
			// A pathological diagram can stall mermaid's layout for tens of seconds
			// on the main thread; cap it so one hostile block cannot freeze the UI.
			const { svg } = await Promise.race([
				window.mermaid.render(id, code),
				new Promise((_, reject) => setTimeout(() => reject(new Error("render timed out")), MERMAID_TIMEOUT_MS)),
			]);
			block.querySelector(".mermaid-error")?.remove();
			block.querySelector("svg")?.remove();
			src.insertAdjacentHTML("beforebegin", svg);
			src.style.display = "none";
			block.classList.remove("pending", "errored");
			block.classList.add("rendered");
		} catch (e) {
			// Mermaid can leave a dangling error element behind; the source stays
			// visible with a note instead of a blank row.
			const sweep = () => {
				document.getElementById(id)?.remove();
				document.getElementById("d" + id)?.remove();
			};
			sweep();
			// On a timeout, mermaid is still running and may inject its temp node
			// after we bailed; sweep once more past the timeout to avoid an orphan.
			setTimeout(sweep, MERMAID_TIMEOUT_MS);
			block.classList.remove("pending");
			block.classList.add("errored");
			if (!block.querySelector(".mermaid-error")) {
				const note = document.createElement("div");
				note.className = "mermaid-error";
				note.textContent = "diagram failed to render: " + (e && e.message ? e.message : e);
				block.prepend(note);
			}
		}
	}

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				renderMermaid(entry.target);
			}
		},
		{ rootMargin: "200% 0%" },
	);

	function observeMermaid(root) {
		for (const block of root.querySelectorAll(".mermaid-block.pending")) {
			observer.observe(block);
		}
	}

	////////////////////////////////
	//  Rows

	function formatTime(at) {
		if (at === undefined || at === null || Number.isNaN(at)) return "";
		const d = new Date(at);
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return sameDay ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
	}

	function buildRow(m) {
		const row = document.createElement("article");
		row.className = "row " + (m.role === "user" ? "user" : "agent");
		if (m.id !== undefined && m.id !== null) row.dataset.id = String(m.id);

		const meta = document.createElement("div");
		meta.className = "meta";
		const from = document.createElement("span");
		from.className = "from";
		from.textContent = m.from || (m.role === "user" ? "you" : "agent");
		meta.appendChild(from);
		const at = document.createElement("span");
		at.className = "at";
		at.textContent = formatTime(m.at);
		meta.appendChild(at);
		if (m.status && m.status !== "completed") {
			const status = document.createElement("span");
			status.className = "status " + (m.status === "error" ? "error" : "running");
			status.textContent = m.status;
			meta.appendChild(status);
		}
		row.appendChild(meta);

		const body = document.createElement("div");
		body.className = "body";
		body.innerHTML = md.render(m.body || "");
		row.appendChild(body);

		if (Array.isArray(m.files) && m.files.length > 0) {
			row.appendChild(buildFiles(m.files));
		}
		return row;
	}

	function buildFiles(files) {
		const wrap = document.createElement("div");
		wrap.className = "files";
		for (const f of files) {
			const isImage = f.mime && f.mime.indexOf("image/") === 0 && f.src;
			if (isImage) {
				const img = document.createElement("img");
				img.className = "thumb";
				img.loading = "lazy";
				img.src = f.src;
				img.alt = f.name || "";
				wrap.appendChild(img);
			} else {
				const chip = document.createElement("span");
				chip.className = "chip";
				const name = document.createElement("span");
				name.className = "name";
				name.textContent = f.name || "file";
				chip.title = f.name || "";
				chip.appendChild(name);
				wrap.appendChild(chip);
			}
		}
		return wrap;
	}

	////////////////////////////////
	//  Scroll

	function nearBottom() {
		const el = document.scrollingElement;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
	}

	function scrollToBottom() {
		// content-visibility:auto makes scrollHeight an estimate while off-screen
		// rows are skipped, so a raw scrollTop = scrollHeight can land short of the
		// last message. Anchor on the actual last row instead.
		const last = container.lastElementChild;
		if (last) {
			last.scrollIntoView(false);
		} else {
			document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
		}
	}

	////////////////////////////////
	//  Public API

	function appendMessages(messages) {
		const stick = nearBottom();
		for (const m of messages) {
			const row = buildRow(m);
			const existing =
				m.id !== undefined && m.id !== null
					? container.querySelector('.row[data-id="' + CSS.escape(String(m.id)) + '"]')
					: null;
			if (existing) {
				// The observer holds strong refs; release the old row's blocks so a
				// replaced (e.g. status-updated) message cannot leak detached nodes.
				for (const block of existing.querySelectorAll(".mermaid-block")) {
					observer.unobserve(block);
				}
				existing.replaceWith(row);
			} else {
				container.appendChild(row);
			}
			observeMermaid(row);
		}
		if (stick) scrollToBottom();
	}

	function setMessages(messages) {
		observer.disconnect();
		container.replaceChildren();
		for (const m of messages) {
			const row = buildRow(m);
			container.appendChild(row);
			observeMermaid(row);
		}
		scrollToBottom();
	}

	function setTheme(dark) {
		document.documentElement.classList.toggle("dark", !!dark);
		document.getElementById("hl-light").disabled = !!dark;
		document.getElementById("hl-dark").disabled = !dark;
		initMermaid();
		// Already-rendered diagrams carry the old palette; restore the source and
		// let the observer re-render them with the new theme. Errored blocks get a
		// harmless retry so their note matches the theme too.
		for (const block of container.querySelectorAll(".mermaid-block.rendered, .mermaid-block.errored")) {
			block.querySelector("svg")?.remove();
			const src = block.querySelector(".mermaid-src");
			if (src) src.style.display = "";
			block.classList.remove("rendered", "errored");
			block.classList.add("pending");
			observer.observe(block);
		}
	}

	initMermaid();

	window.thread = { setMessages, appendMessages, setTheme };
})();
