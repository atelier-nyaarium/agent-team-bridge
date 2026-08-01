"use strict";

// Renderer for one conversation thread. Kotlin drives it through window.thread:
//   thread.setMessages({messages, firstUnreadId})  full transcript replace, snap/hold at
//                                                   firstUnreadId (null = bottom)
//   thread.appendMessages(messages)                append (or in-place update when an id repeats)
//   thread.setTheme(dark)                           light/dark swap, re-themes hljs + mermaid
//   thread.setComposerOccupied(occupied)            greys Cancel on a failed row while the
//                                                   composer holds text it would overwrite
//   thread.setVisible(visible)                      app foreground/background transition
//   thread.revealFirstUnread(idOrNull, regionIds)   re-snap/hold an already-rendered transcript
//   thread.flushReadUpTo()                          flush any pending debounced read receipt now
// Message shape: {id, role: "user"|"agent", from, at, body, status?, counts?, ownSend?,
//   arrivedVisible?, files?: [{name, mime, src?, size?, modifiedAt?, previewable, label,
//   decoration?: {title, kind}}]}
// The host classifies, labels, orders, and filters attachments; hidden ones never arrive.
// `counts`: this row counts toward unread (an inbound row with real mailbox coordinates).
// `ownSend`: this row is the local optimistic send (never a settled echo from another device).
// `arrivedVisible`: present (false) only when the row arrived while the app was backgrounded.
// Markdown is semi-trusted: html stays off and links render two-tier (standard schemes as real
// anchors, everything else inert/red - see markdown-link-rules.js); the WebView layer
// additionally blocks every non-appassets resource load.

(function () {
	const container = document.getElementById("messages");

	////////////////////////////////
	//  Markdown

	const md = window.markdownit({
		html: false,
		breaks: true,
		// No auto-linkification: bare text like `readme.md` or a pasted hostname must stay text.
		// A link renders only when written explicitly as [label](url).
		linkify: false,
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

	// Two-tier links: standard schemes render as ordinary anchors, everything else as an inert
	// red "unhandled" link whose tap raises the copy-only menu (see markdown-link-rules.js).
	// Re-pushed by the app whenever the claimed set changes (a plugin toggle), setTheme-style.
	const handledSchemes = { value: [] };
	window.setHandledSchemes = (list) => {
		handledSchemes.value = Array.isArray(list) ? list : [];
	};
	window.installThreadLinkRules(md, handledSchemes);

	// Unhandled links carry no href (nothing to navigate, so no shouldOverrideUrlLoading hop);
	// a delegated tap feeds their data-href to the native link menu instead. Standard anchors
	// keep their href and never match here.
	container.addEventListener("click", (e) => {
		const a = e.target.closest("a.link-unhandled, a.link-handled");
		if (!a) return;
		e.preventDefault();
		const href = a.dataset.href || "";

		// A claimed link is dispatched WITH the row it sits in. The same URL in two messages points
		// at two different snapshots, and a row id alone can be reused after a forget, so the row's
		// `at` rides along and the app resolves the pair before handing it to a plugin.
		if (a.classList.contains("link-handled") && window.Android && typeof window.Android.linkTap === "function") {
			const row = a.closest("[data-id]");
			window.Android.linkTap(String(row ? row.dataset.id || "" : ""), String(row ? row.dataset.at || "" : ""), href);
			return;
		}
		if (window.Android && typeof window.Android.linkMenu === "function") {
			window.Android.linkMenu(href);
		}
	});

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

	// Whether the composer currently holds text. Only Kotlin can see that box, so it mirrors the
	// state here to gate the one action that would overwrite it.
	let composerOccupied = false;

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
		if (m.at !== undefined && m.at !== null) row.dataset.at = String(m.at);

		// Top-right row actions: a flex group anchored to the row's right edge, so it grows LEFT as
		// buttons are added rather than each button carrying its own hardcoded offset. DOM order is
		// left-to-right visual order, so Play (conditional) comes before Copy (always present, so it
		// stays the rightmost, wall-anchored button regardless of whether Play is shown).
		const actions = document.createElement("div");
		actions.className = "row-actions";

		// Agent rows get a Play button when the host enables it (canPlay rides each message). The host
		// pushes state back through setPlayStates; a rebuilt row starts idle and is repainted from the
		// state this module still holds, so a re-render cannot lose it.
		const hasPlay = m.canPlay && m.role === "agent" && m.at !== undefined && m.at !== null;
		if (hasPlay) {
			const play = document.createElement("button");
			play.className = "play-btn";
			play.setAttribute("aria-label", "Play message");
			// Painted as it is built, so a rebuilt row is already correct rather than idle until the
			// next push. There may not BE a next push: state changes when playback does, not when a
			// row re-renders.
			applyPlayState(play, m.at);
			// A row with a state is not pressable (pointer-events: none), so a tap here can only ever
			// be a request to start one that is idle.
			play.addEventListener("click", () => {
				if (window.Android && typeof window.Android.playMessage === "function") {
					window.Android.playMessage(String(m.at));
				}
			});
			actions.appendChild(play);
		}

		// Copies the raw message source (markdown and mermaid fences as typed, not the rendered
		// HTML/diagram) via the native bridge - WebView's own clipboard API needs an https-like
		// secure context this file:// asset origin does not reliably get. Every row gets one.
		const copy = document.createElement("button");
		copy.className = "copy-btn";
		copy.textContent = "\u{1F4CB}";
		copy.setAttribute("aria-label", "Copy raw message");
		copy.addEventListener("click", () => {
			if (window.Android && typeof window.Android.copyToClipboard === "function") {
				window.Android.copyToClipboard(m.body || "");
			}
		});
		actions.appendChild(copy);

		row.appendChild(actions);

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
			status.textContent = m.status === "error" ? "failed" : m.status;
			meta.appendChild(status);
		}
		row.appendChild(meta);

		const body = document.createElement("div");
		body.className = "body";
		// Break CommonMark's blockquote lazy-continuation (see markdown-lazy-blockquote.js's own
		// header) before rendering, so a plain line right after a quoted line with no blank line
		// between them starts its own block instead of being absorbed into the quote.
		body.innerHTML = md.render(window.breakLazyBlockquoteContinuations(m.body || ""));
		splitRefLabels(body);
		row.appendChild(body);

		if (Array.isArray(m.files) && m.files.length > 0) {
			row.appendChild(buildFiles(m.files));
		}
		if (m.status === "error" && m.role === "user" && m.id !== undefined && m.id !== null) {
			row.appendChild(buildFailedActions(String(m.id)));
		}
		return row;
	}

	/**
	 * The two ways out of a failed send. Cancel is disabled while the composer holds text, since
	 * it hands this message's content back to that same box and would otherwise have to either
	 * overwrite what is being typed or silently merge with it.
	 */
	function buildFailedActions(id) {
		const actions = document.createElement("div");
		actions.className = "failed-actions";

		const retry = document.createElement("button");
		retry.className = "failed-action retry";
		retry.type = "button";
		retry.textContent = "Retry";
		retry.addEventListener("click", () => {
			if (window.Android && typeof window.Android.retryMessage === "function") {
				window.Android.retryMessage(id);
			}
		});

		const cancel = document.createElement("button");
		cancel.className = "failed-action cancel";
		cancel.type = "button";
		cancel.textContent = "Cancel";
		cancel.dataset.needsEmptyComposer = "1";
		cancel.disabled = composerOccupied;
		cancel.addEventListener("click", () => {
			if (cancel.disabled) return;
			if (window.Android && typeof window.Android.cancelMessage === "function") {
				window.Android.cancelMessage(id);
			}
		});

		actions.appendChild(retry);
		actions.appendChild(cancel);
		return actions;
	}

	// Tapping an attachment hands its path to the host, which opens it in the
	// system viewer/share sheet. The bridge takes only the attachments-relative
	// path; absent (e.g. in a browser harness) taps are simply inert.
	function openAttachment(src) {
		if (!src) return;
		const rel = src.split("/attachments/")[1];
		if (rel && window.Android && typeof window.Android.openAttachment === "function") {
			window.Android.openAttachment(rel);
		}
	}

	/**
	 * Give a `file : symbol` chip label its two weights.
	 *
	 * The agent writes the label (see the references plugin's guidance), so this only splits what
	 * already matches that shape and leaves anything else alone. Every part goes in through
	 * textContent: a label is agent-authored text and never markup.
	 */
	function splitRefLabels(root) {
		for (const a of root.querySelectorAll("a.link-handled")) {
			const text = a.textContent;
			const at = text.indexOf(" : ");
			if (at === -1) continue;

			const file = document.createElement("span");
			file.className = "ref-file";
			file.textContent = text.slice(0, at);
			const sep = document.createElement("span");
			sep.className = "ref-sep";
			sep.textContent = ":";
			const sym = document.createElement("span");
			sym.className = "ref-sym";
			sym.textContent = text.slice(at + 3);

			a.textContent = "";
			a.append(file, sep, sym);
		}
	}

	// How long each extracted video frame holds. Slow enough to read, fast enough to look alive.
	const FRAME_HOLD_MS = 500;

	// Cycle a video's frames in place. The interval is parked ON the element so stopCycling can find
	// it: a row is REPLACED whenever its frames land, and a timer left running would keep firing
	// against a node that is no longer in the document, holding it and its frames alive forever.
	function startCycling(img, frames) {
		let i = 0;
		img.src = frames[0];
		img._cycle = setInterval(() => {
			i = (i + 1) % frames.length;
			img.src = frames[i];
		}, FRAME_HOLD_MS);
	}

	function stopCycling(root) {
		for (const img of root.querySelectorAll("img.thumb")) {
			if (img._cycle) {
				clearInterval(img._cycle);
				img._cycle = null;
			}
		}
	}

	// The host decides what is previewable, what each entry is called, and what order they come in.
	// Hidden entries never arrive. This function only draws.
	function buildFiles(files) {
		const wrap = document.createElement("div");
		wrap.className = "attachments";
		const thumbs = document.createElement("div");
		thumbs.className = "thumbs";
		const rows = document.createElement("div");
		rows.className = "filerows";

		for (const f of files) {
			if (f.previewable && f.src) {
				const img = document.createElement("img");
				img.className = "thumb";
				img.loading = "lazy";
				// A video's tile draws its frames, never the file: an img tag cannot render an mp4.
				img.src = f.frames && f.frames.length ? f.frames[0] : f.src;
				// Named for assistive tech only. A thumbnail shows no filename: the picture is the
				// label, and a wall of names under a wall of images is the noise being removed.
				img.alt = f.label;
				img.addEventListener("click", () => openAttachment(f.src));
				if (f.frames && f.frames.length > 1) startCycling(img, f.frames);
				thumbs.appendChild(img);
			} else {
				rows.appendChild(buildFileRow(f));
			}
		}

		if (thumbs.childElementCount > 0) wrap.appendChild(thumbs);
		if (rows.childElementCount > 0) wrap.appendChild(rows);
		return wrap;
	}

	// A leading glyph, built as real SVG nodes rather than markup, since everything else in this
	// renderer reaches the DOM without parsing a string.
	function fileGlyph() {
		const NS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("class", "glyph");
		svg.setAttribute("viewBox", "0 0 14 16");
		svg.setAttribute("aria-hidden", "true");
		const page = document.createElementNS(NS, "path");
		page.setAttribute("d", "M2.5 0.5h6.2l2.8 2.8v12.2h-9z");
		page.setAttribute("fill", "none");
		page.setAttribute("stroke", "currentColor");
		const fold = document.createElementNS(NS, "path");
		fold.setAttribute("d", "M8.7 0.5v2.8h2.8");
		fold.setAttribute("fill", "none");
		fold.setAttribute("stroke", "currentColor");
		svg.append(page, fold);
		return svg;
	}

	// One tappable line, clipped rather than wrapped. A decoration (host-supplied per-file data)
	// carries its own accent styling. Labels are agent-authored, so they enter the DOM via
	// textContent only.
	function buildFileRow(f) {
		const deco = f.decoration || null;
		const row = document.createElement(f.src ? "button" : "div");
		row.className = deco ? "filerow deco" : "filerow";
		if (f.src) row.type = "button";
		if (deco && typeof deco.kind === "string" && /^[a-z0-9-]{1,32}$/.test(deco.kind)) {
			row.classList.add("deco-" + deco.kind);
		}

		row.appendChild(fileGlyph());

		const name = document.createElement("span");
		name.className = "name";
		name.textContent = f.label;
		row.title = f.name || "";
		row.appendChild(name);

		if (f.src) row.addEventListener("click", () => openAttachment(f.src));
		return row;
	}

	////////////////////////////////
	//  Scroll

	function nearBottom() {
		const el = document.scrollingElement;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
	}

	// Track whether the reader is parked at the bottom, so a viewport resize (the
	// soft keyboard opening or closing shrinks/grows the WebView) can re-pin to the
	// last message. `stuck` reflects reader INTENT, so only genuine user scrolls
	// update it: the `pinning` window suppresses the recompute while our own
	// programmatic scroll-to-bottom and the IME-resize reflow it rides settle.
	// Without that guard an estimated-metric scroll event mid-animation could latch
	// `stuck` false and silently defeat the re-pin.
	let stuck = true;
	let pinning = false;
	let pinTimer = 0;
	// Whether the view is anchored at the "New messages" divider (the reveal snap/hold), released
	// only by genuine user INPUT - never a scroll event, since the divider's own re-pin (below) and
	// native scroll anchoring both fire scroll events indistinguishable from a real one.
	let snapped = false;
	["touchstart", "pointerdown", "wheel", "keydown"].forEach((type) =>
		window.addEventListener(type, () => { snapped = false; }, { passive: true }),
	);

	// A programmatic scroll (bottom-follow or the divider snap) suppresses receipts/stuck-recompute
	// for its duration, then runs one pointer walk on release - this IS the "read check once after
	// the open snap/follow" moment: it runs a full rendering step after the jump, so
	// content-visibility relevancy has updated and layout rects are real (a same-task read right
	// after a jump into an unrendered region would still see placeholder geometry and could mark
	// unseen rows read).
	function runPin(scrollFn) {
		pinning = true;
		scrollFn();
		clearTimeout(pinTimer);
		pinTimer = setTimeout(() => {
			pinning = false;
			walkPointer();
		}, 200);
	}

	function scrollToBottom() {
		stuck = true;
		// A prior divider snap must not survive a bottom jump - otherwise the next resize/growth
		// repin (which fires both flags' pins) would yank the reader straight back to the divider.
		snapped = false;
		runPin(() => {
			const last = container.lastElementChild;
			if (last) {
				// content-visibility:auto makes scrollHeight an estimate while off-screen
				// rows are skipped, so a raw scrollTop = scrollHeight can land short of the
				// last message. Anchor on the actual last row instead.
				last.scrollIntoView(false);
			} else {
				document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
			}
		});
	}

	// Snap/hold at the divider (the first still-unread row): reader intent here is "reading
	// backlog", the opposite of parked-at-bottom, so this explicitly clears `stuck` - otherwise a
	// stale-true `stuck` would let the very next resize/growth repin fling the reader to the bottom
	// and mass-clear the unread it was just given to read.
	function scrollToDivider() {
		if (!divider) return;
		stuck = false;
		snapped = true;
		runPin(() => divider.scrollIntoView({ block: "start" }));
	}

	window.addEventListener(
		"scroll",
		() => {
			if (pinning) return;
			stuck = nearBottom();
			clearTimeout(scrollSettleTimer);
			scrollSettleTimer = setTimeout(walkPointer, 150);
		},
		{ passive: true },
	);
	let scrollSettleTimer = 0;

	function repin() {
		if (stuck) requestAnimationFrame(scrollToBottom);
		if (snapped) requestAnimationFrame(scrollToDivider);
	}
	window.addEventListener("resize", repin);
	if (window.visualViewport) window.visualViewport.addEventListener("resize", repin);

	// Async row growth (image decode, mermaid render, code highlight) after the initial landing can
	// shift positions with no scroll event at all; content-visibility:auto also makes scrollHeight
	// an estimate. A ResizeObserver on the transcript re-runs whichever pin is active, and (in every
	// state) re-checks the read pointer, since shrinking content can pull a row's bottom into view
	// with nothing else to trigger a walk.
	new ResizeObserver(() => {
		if (stuck) requestAnimationFrame(scrollToBottom);
		if (snapped) requestAnimationFrame(scrollToDivider);
		walkPointer();
	}).observe(container);

	////////////////////////////////
	//  Read pointer: scroll-driven unread tracking
	//
	//  IntersectionObserver cannot fire at "a row's bottom edge enters the viewport" (it only fires
	//  at threshold crossings, and the final on-screen rows never exit), so reads are driven by
	//  walking a monotonic next-unread pointer against live layout instead, on every event that
	//  could plausibly bring a row's bottom into view.

	// Ids of rows still counting toward unread, in thread order - a union of what Kotlin ships at
	// reveal time and what appendMessages extends locally.
	let region = [];
	// Index into `region` of the next row to check; everything before it has already been read.
	let pointerIdx = 0;
	// The highest read row reported so far this settle window ({id, at}), surviving a setMessages
	// rebuild so a pending report is never lost. Cleared by flushReadUpTo.
	let pendingReport = null;
	let reportTimer = 0;
	// Whether the page is currently visible (set by Kotlin via setVisible). While false, the walk
	// itself - not just the bridge report - is suppressed: a mermaid/image settle that happens to
	// run while backgrounded must not silently consume unread rows a later report would then wrongly
	// credit on resume.
	let pageVisible = true;

	function rowFor(id) {
		return container.querySelector('.row[data-id="' + CSS.escape(String(id)) + '"]');
	}

	// scrollIntoView's bottom-alignment leaves a sub-pixel rounding residue (observed ~0.66px) between
	// a row's true bottom edge and window.innerHeight, so a strict > comparison permanently blocks on
	// the last row of the transcript - it sits fractionally "below the fold" forever, only freed once
	// later content pushes it up. A small tolerance absorbs that residue without misreading a row that
	// is genuinely still below the fold by a meaningful margin.
	const BOTTOM_EDGE_SLOP_PX = 2;

	function walkPointer() {
		if (pinning || !pageVisible) return;
		let advanced = false;
		while (pointerIdx < region.length) {
			const row = rowFor(region[pointerIdx]);
			if (!row) {
				// The region can outlive its row (a forget sweep removed it) - skip silently
				// rather than stalling the pointer on a row that will never exist.
				pointerIdx++;
				continue;
			}
			if (row.getBoundingClientRect().bottom > window.innerHeight + BOTTOM_EDGE_SLOP_PX) break;
			pendingReport = { id: region[pointerIdx], at: row.dataset.at };
			pointerIdx++;
			advanced = true;
		}
		if (advanced) {
			placeDividerAtPointer();
			clearTimeout(reportTimer);
			reportTimer = setTimeout(flushReadUpTo, 250);
		}
	}

	function flushReadUpTo() {
		clearTimeout(reportTimer);
		if (!pendingReport) return;
		const report = pendingReport;
		pendingReport = null;
		if (window.Android && typeof window.Android.readUpTo === "function") {
			window.Android.readUpTo(String(report.id), String(report.at));
		}
	}

	function setVisible(visible) {
		const wasVisible = pageVisible;
		pageVisible = !!visible;
		// Resume walk: ordered after any reveal already queued by this same resume, since both ride
		// the same WebView eval queue.
		if (pageVisible && !wasVisible) walkPointer();
	}

	// Add eligible ids to the region, deduped - called from both appendMessages branches (a
	// genuinely new row, and a row that transitions to eligible via an id-repeat), so an
	// already-queued id is simply a no-op here.
	function extendRegion(ids) {
		for (const id of ids) if (!region.includes(id)) region.push(id);
	}

	// Union-merge a region shipped by a reveal: ids already locally queued-but-not-walked are kept
	// (in case the shipped list is momentarily behind), new ids are appended, and the pointer resets
	// to the front of the merged set - nothing in it has been walked, by construction (shipped ids
	// are always "still unread" per Kotlin's just-flushed anchor; local not-yet-walked ids are by
	// definition not walked either).
	function applyRegion(ids) {
		const notYetWalked = region.slice(pointerIdx);
		const merged = [];
		const seen = new Set();
		for (const id of ids.concat(notYetWalked)) {
			if (seen.has(id)) continue;
			seen.add(id);
			merged.push(id);
		}
		region = merged;
		pointerIdx = 0;
	}

	////////////////////////////////
	//  New-messages divider

	let divider = null;

	function buildDivider() {
		const el = document.createElement("div");
		el.className = "new-messages-divider";
		el.textContent = "New messages";
		return el;
	}

	// Inserts (or moves) the divider directly above the current boundary row: the next still-unread
	// row when there is one, else the LAST row ever tracked in `region` this visit, once caught up -
	// so the divider persists as a "read up to here this visit" bookmark instead of vanishing (only
	// a genuine reopen with nothing unread, via revealFirstUnread/setMessages, removes it). Anchoring
	// to a real row rather than "the last DOM child" means later appends (an own-send, a further
	// reply) never land between the divider and the row it marks, and a live-arriving batch simply
	// moves the divider to sit above the newest tracked row instead of relocating past it.
	function placeDividerAtPointer() {
		if (region.length === 0) {
			if (divider) {
				divider.remove();
				divider = null;
			}
			return;
		}
		const anchorId = pointerIdx < region.length ? region[pointerIdx] : region[region.length - 1];
		const row = rowFor(anchorId);
		if (!row) return;
		if (divider) divider.remove();
		divider = buildDivider();
		row.before(divider);
	}

	////////////////////////////////
	//  Public API

	function appendMessages(messages) {
		const stick = nearBottom();
		// A brand-new OWN-send row (the local optimistic append, never a settled echo from another
		// device - see `ownSend`) always jumps to the bottom, even scrolled up. Agent rows respect
		// the reader's position and only follow when already near the bottom or the batch arrived
		// while visible (see heldForVisibility below).
		let sentByUser = false;
		let heldForVisibility = false;
		const newEligibleIds = [];
		for (const m of messages) {
			const row = buildRow(m);
			const existing = m.id !== undefined && m.id !== null ? rowFor(m.id) : null;
			// A row already known to the region (already queued, or already walked past) never
			// re-triggers eligibility side effects on a re-push - only a row seeing `counts` for
			// the FIRST time does. Without this, a fingerprint re-push unrelated to read state (a
			// rename changes displayFrom, re-pushing every row naming that team) would replay a
			// long-read row's stale `arrivedVisible` and spuriously hold position on an already
			// caught-up reader.
			const firstTimeEligible = m.counts && !region.includes(m.id);
			if (existing) {
				// The observer holds strong refs; release the old row's blocks so a
				// replaced (e.g. status-updated) message cannot leak detached nodes.
				for (const block of existing.querySelectorAll(".mermaid-block")) {
					observer.unobserve(block);
				}
				stopCycling(existing);
				existing.replaceWith(row);
				// A row can transition to eligible via an id-repeat (a re-render of the same row id
				// carrying coordinates it did not have before), not just a fresh append. Without
				// registering it here the badge would count it but the pointer could never walk past
				// it while the thread stays open.
				if (firstTimeEligible) {
					newEligibleIds.push(m.id);
					if (m.arrivedVisible === false) heldForVisibility = true;
				}
			} else {
				container.appendChild(row);
				if (m.role === "user" && m.ownSend) sentByUser = true;
				if (firstTimeEligible) {
					newEligibleIds.push(m.id);
					if (m.arrivedVisible === false) heldForVisibility = true;
				}
			}
			observeMermaid(row);
		}
		extendRegion(newEligibleIds);
		if (sentByUser) {
			// Sending a message is an unambiguous "I'm caught up" signal, so the trailing bookmark
			// clears right away instead of staying parked wherever it last sat. Purely visual - the
			// scroll-driven read pointer (and the unread count/notification it drives) is untouched.
			if (divider) {
				divider.remove();
				divider = null;
			}
		} else if (newEligibleIds.length > 0) {
			// Re-anchor the divider to the new boundary whenever eligibility changed, regardless of
			// which branch runs next - a backgrounded arrival needs it placed (nothing else will), a
			// live arrival while scrolled up needs it too (it was otherwise never shown), and a live
			// arrival while stuck at the bottom gets it re-confirmed a moment before scrollToBottom's
			// own pin-release walk settles it in the same place.
			placeDividerAtPointer();
		}
		if (heldForVisibility && !sentByUser) {
			// This batch arrived while backgrounded: hold position instead of auto-following.
			stuck = false;
		} else if (stick || sentByUser) {
			scrollToBottom();
		}
	}

	function setMessages(payload) {
		const messages = payload.messages;
		const firstUnreadId = payload.firstUnreadId;
		observer.disconnect();
		stopCycling(container);
		container.replaceChildren();
		divider = null;
		region = [];
		// Only rows AT OR AFTER the boundary join the region - a historical (already-read) row
		// must never enter it, or a later reveal's union-merge (applyRegion) can place it ahead of
		// the genuinely unread ids in walk order, letting the pointer consume the historical tail
		// and clobber the real report with a stale one.
		// An absent boundary means CAUGHT UP, which is precisely the case where NO row belongs in
		// the region. Seeding it true enrols the whole already-read history instead, and the pointer
		// walk then parks a divider above the last row via placeDividerAtPointer's caught-up
		// fallback - a "New messages" line on a thread with nothing unread, on every fresh rebuild.
		let pastBoundary = false;
		for (const m of messages) {
			if (!pastBoundary && m.id === firstUnreadId) {
				pastBoundary = true;
				divider = buildDivider();
				container.appendChild(divider);
			}
			const row = buildRow(m);
			container.appendChild(row);
			if (pastBoundary && m.counts) region.push(m.id);
			observeMermaid(row);
		}
		pointerIdx = 0;
		if (divider) {
			scrollToDivider();
		} else {
			scrollToBottom();
		}
	}

	// Bridge entrypoint: reveal (or re-reveal) the unread boundary. `regionIds` is union-merged
	// (see applyRegion) so a stale local pointer can never regress. `idOrNull = null` means caught up
	// (nothing left unread) - skips the scroll (a caught-up thread keeps its current position/
	// bottom) but still clears any divider a prior open left behind, or it would strand a
	// "New messages" line above now-read rows forever.
	function revealFirstUnread(idOrNull, regionIds) {
		applyRegion(regionIds || []);
		if (idOrNull === null || idOrNull === undefined) {
			if (divider) {
				divider.remove();
				divider = null;
			}
			return;
		}
		const row = rowFor(idOrNull);
		if (!row) return;
		if (divider) divider.remove();
		divider = buildDivider();
		row.before(divider);
		scrollToDivider();
	}

	/** Kotlin mirrors the composer's own emptiness here, since only it can see that box. Applied to
	 * already-rendered rows too, so a row that failed before you started typing greys immediately. */
	function setComposerOccupied(occupied) {
		composerOccupied = !!occupied;
		for (const btn of document.querySelectorAll(".failed-action[data-needs-empty-composer]")) {
			btn.disabled = composerOccupied;
		}
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

	// Per-row playback state, pushed by the host as { "<at>": "queued"|"loading"|"playing" }. Rows the
	// host does not mention are idle. Kept as host-pushed state rather than row payload: the renderer's
	// fingerprint decides re-render, and anything riding the payload that changes while a row is on
	// screen has to be folded into it or the row goes stale. Bridge state mutating in place is outside
	// the fingerprint by design.
	let playStates = {};
	const PLAY_LABEL = { queued: "Queued", loading: "Loading", playing: "\u25A0 Playing" };

	function applyPlayState(btn, at) {
		const state = playStates[String(at)];
		btn.classList.remove("queued", "loading", "playing");
		if (state) {
			btn.classList.add(state);
			btn.textContent = PLAY_LABEL[state] || state;
		} else {
			btn.textContent = "\u25B6";
		}
	}

	function paintPlayStates() {
		for (const btn of container.querySelectorAll(".play-btn")) {
			applyPlayState(btn, btn.parentElement.dataset.at);
		}
	}

	function setPlayStates(states) {
		playStates = states || {};
		paintPlayStates();
	}


	window.thread = {
		setMessages,
		setComposerOccupied,
		appendMessages,
		setTheme,
		setPlayStates,
		setVisible,
		revealFirstUnread,
		flushReadUpTo,
	};
})();
