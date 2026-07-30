////////////////////////////////
//  Interfaces & Types

export interface LimitNotice {
	/** The matched headline, rejoined across wrap rows. */
	headline: string;
	/** Everything after the headline's first middle dot, e.g. "resets 5pm". Null when it has no dot. */
	detail: string | null;
}

////////////////////////////////
//  Functions & Helpers

// Pure classifiers over a captured tmux pane: what state the agent's REPL screen shows. Shared
// between the host daemon's wake/readiness logic (via tmuxCore.ts, which re-exports them) and the
// gateway (the vibe-check idle gate evaluates peek results itself). The Kotlin twin lives in
// android/.../AgentScreen.kt - keep the markers in lockstep.

// The ready composer prompt "❯" anchored at column 0. The dev-channels / folder-trust /
// resume-picker menus show an INDENTED cursor ("  ❯ 1."), so the line-start anchor matches the real
// composer and never a menu line.
const COMPOSER_RE = /^❯/mu;
// The "esc to interrupt" hint in the bottom status line, always preceded by a middle-dot separator.
const WORKING_HINT = "· esc";
// A queued/in-progress task or plan item also renders in the footer while a turn is in flight,
// e.g. "◯ idle-pushback" - same signal as the esc hint, checked in the same bounded region.
const WORKING_CIRCLE_HINT = "◯";
// The auth status renders in the bottom toolbar, below the composer's lower rule line (three U+2500
// dashes). Scoping the logged-out check to the region after the last rule keeps "/login" typed into
// the composer, or printed in the transcript above, from tripping it.
const TOOLBAR_RULE = "───";
const LOGGED_OUT_RE = /Not logged in|Run \/login/;
// A row that IS the rule, not merely containing it: the composer's box border spans the full pane
// width with no other content, so this is a stricter test than TOOLBAR_RULE's .includes() - it can't
// false-positive on a stray few dashes inside transcript/tool-output text.
const FULL_RULE_RE = /^─+$/;

// A rule row for the usage-limit check, as any run of box-drawing characters rather than the specific
// glyph: that dialog's divider is heavier than the composer's U+2500 border, and a restyle must not
// silently disable detection. TITLED_BORDER_RE is the same run leading a row that also carries text,
// which the composer's top border does once a session has a name.
const ANY_RULE_RE = /^[─-╿]+$/u;
const TITLED_BORDER_RE = /^[─-╿]{3,}/u;
// An INDENTED prompt followed by a numbered option, i.e. a selectable dialog holds the pane. Column 0
// would be the composer, so the leading whitespace is load-bearing.
const MENU_CURSOR_RE = /^\s+❯\s*\d+\./mu;
// The usage-limit dialog's own cancel choice, matched on the label's stable tail. It collapses to a
// bare "Stop" on usage-based billing, which is too generic to match, so that case is not detected.
const LIMIT_MENU_RE = /wait for limit to reset/;
// Deliberately names no model, plan, seat kind, or billing period: those churn, and an enumeration
// fails silently the first time one is renamed. Each branch is a literal prefix of one of the CLI's
// own headline builders, so the variable part stays payload to display rather than something to match.
// The apostrophe slot is \W so a straight or typographic quote both match; the CLI emits ASCII today.
const LIMIT_HEADLINE_RE = new RegExp(
	[
		"You\\Wve (?:hit|reached) your\\b",
		"You\\Wre out of (?:extra )?usage\\b",
		"is out of usage\\b",
		"requires usage credits\\b",
		"seat type doesn\\Wt include\\b",
		"usage allocation has been disabled\\b",
		"usage limit is set to \\$0",
		"This service is disabled for your org\\b",
	].join("|"),
	"u",
);
// Rows to read above the divider. Panes are pinned to 58 columns, where a short reset-time headline
// fits on one row and a long admin/org suffix wraps onto a second or third.
const LIMIT_WINDOW_ROWS = 3;

// capture-pane runs with -e, so the screen carries SGR color escapes. Strip them before matching: an
// escape at the start of a line defeats the composer's ^ anchor, and one splitting a phrase defeats a
// substring check. The Kotlin twin strips the same in AgentScreen.kt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the literal ESC of an ANSI CSI sequence
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(screen: string): string {
	return screen.replace(ANSI_CSI_RE, "");
}

/** Whether a captured pane shows claude at the idle REPL composer, i.e. startup finished (menus
 * cleared, history rendered). The composer prompt sits at column 0; the dev-channels / folder-trust /
 * resume-picker menus show an indented cursor, so the line-start anchor never matches a menu. Both a
 * fresh launch and a resumed session settle here. Used once per wake or fresh spawn to know the
 * session is up; the working/done state (isAgentWorking) takes over after the first message. The
 * Kotlin twin lives in AgentScreen.kt. */
export function isAgentReady(screen: string): boolean {
	return COMPOSER_RE.test(stripAnsi(screen));
}

/** Whether a captured pane shows claude actively working a turn: either the "esc to interrupt" hint
 * or a task-bullet ("◯ <name>", a queued/in-progress plan or task item) sits in the bottom status
 * line. The footer's height is dynamic (terminal width/wrapping), so a fixed line count is wrong in
 * general - bound the search by the actual rule instead, same as isLoggedOut. Falls back to the last
 * two lines only when no rule is present at all (a malformed/partial capture): with no boundary to
 * anchor on, that stays the safer guess over treating the whole screen as fair game, which risks
 * matching a stray "esc" sitting in scrollback/transcript text above. The Kotlin twin lives in
 * AgentScreen.kt. */
export function isAgentWorking(screen: string): boolean {
	const lines = stripAnsi(screen).split("\n");
	const lastRule = lines.findLastIndex((line) => line.includes(TOOLBAR_RULE));
	const footer = lastRule >= 0 ? lines.slice(lastRule + 1) : lines.slice(-2);
	return footer.some((line) => line.includes(WORKING_HINT) || line.includes(WORKING_CIRCLE_HINT));
}

/** Whether the captured pane shows claude logged out: its bottom toolbar prints "Not logged in" /
 * "Run /login". Independent of ready/working - a logged-out session still renders the composer, so a
 * caller must check this separately. Detectable at any peek (the footer persists), including a token
 * that expires mid-session. The Kotlin twin lives in AgentScreen.kt. */
export function isLoggedOut(screen: string): boolean {
	const lines = stripAnsi(screen).split("\n");
	const lastRule = lines.findLastIndex((line) => line.includes(TOOLBAR_RULE));
	const footer = lines.slice(lastRule + 1).join("\n");
	return LOGGED_OUT_RE.test(footer);
}

/** Whether the captured pane shows the composer box border at all: a row that (once trimmed) is
 * ENTIRELY the rule character, the same top/bottom border isAgentWorking/isLoggedOut anchor their
 * footer search on. Present whether idle or mid-turn (the box is always drawn once the REPL is up),
 * so this does not distinguish working from idle - it distinguishes "a real composer is rendered" from
 * a raw shell / boot screen / menu that has none. The Kotlin twin lives in AgentScreen.kt. */
export function isAtPrompt(screen: string): boolean {
	return stripAnsi(screen)
		.split("\n")
		.some((line) => FULL_RULE_RE.test(line.trim()));
}

/** Whether the LIVE composer box (the region between the last two full-width rule rows) is empty: a
 * bare "❯" with nothing staged. The gateway's vibe-check rename injection requires this - typing
 * into a composer holding a human's staged draft would corrupt it and submit the mangled line.
 * Scoped to the box deliberately: past slash commands echo in the transcript as "❯ /model" lines
 * ABOVE the box, which must not read as staged text.
 *
 * The box content is NOT reliable on its own: Claude Code fills an idle composer with a
 * greyed-out placeholder/suggested-command ghost text (e.g. "❯ keep going"), which renders
 * identically to real staged input by content alone - confirmed on-device, the box is never
 * actually bare in practice. The toolbar line directly below the box is the real tell: it carries
 * extra " · <hint>" segments (e.g. "· ← for agents", "· ? for shortcuts") only while the box is
 * empty; real staged text collapses it down to the bare mode phrase ("bypass permissions on
 * (shift+tab to cycle)") with no trailing dot. Confirmed by live capture (typing "jjjj" made the
 * hint segment vanish immediately; clearing it brought the hint back). Excludes the "esc to
 * interrupt" working hint specifically, since that marks a busy turn rather than an empty box -
 * moot at the one real call site (already gated on !isAgentWorking) but kept so the function is
 * correct standing alone. Gateway-only; no Kotlin twin. */
export function isPromptEmpty(screen: string): boolean {
	const lines = stripAnsi(screen).split("\n");
	const ruleIdxs: number[] = [];
	lines.forEach((line, i) => {
		if (FULL_RULE_RE.test(line.trim())) ruleIdxs.push(i);
	});
	if (ruleIdxs.length < 2) return false;
	const inner = lines.slice(ruleIdxs[ruleIdxs.length - 2] + 1, ruleIdxs[ruleIdxs.length - 1]);
	// Require a rendered prompt inside the box (a rule-bounded region with no ❯ is not a composer),
	// then accept a bare prompt outright - any other content might be a real draft OR just the
	// placeholder ghost text, so fall through to the toolbar hint to tell those apart.
	if (!inner.some((line) => line.startsWith("❯"))) return false;
	if (inner.every((line) => /^❯?\s*$/.test(line))) return true;
	const toolbarLine = lines[ruleIdxs[ruleIdxs.length - 1] + 1] ?? "";
	return toolbarLine.includes("·") && !toolbarLine.includes(WORKING_HINT);
}

/** The usage-limit dialog, i.e. the agent has stopped and cannot progress until the choice is answered.
 * Returns the headline and the text after its middle dot, or null.
 *
 * Detected by POSITION rather than by scanning the screen, because the headline renders in the
 * transcript and lingers in scrollback after the dialog closes; a whole-screen match would latch
 * permanently and would also trip on a session that merely quotes the wording while discussing it.
 *
 * Both below-divider signals are required before the headline pattern runs at all. Neither is
 * sufficient alone: the dialog's title is reused by unrelated dialogs, and a numbered menu is just as
 * present on a permission prompt. Once the choice is answered the composer returns, which puts the
 * headline out of window, so the notice clears itself with no state to expire.
 *
 * The Kotlin twin lives in AgentScreen.kt. */
export function limitNotice(screen: string): LimitNotice | null {
	const lines = stripAnsi(screen).split("\n");
	// Lowest divider whose region below carries both signals. Not simply the last rule: a dialog that
	// draws its own bottom border would put that border last, leaving the menu above it unseen.
	let divider = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!ANY_RULE_RE.test(lines[i].trim())) continue;
		const below = lines.slice(i + 1).join("\n");
		if (MENU_CURSOR_RE.test(below) && LIMIT_MENU_RE.test(below)) {
			divider = i;
			break;
		}
	}
	if (divider < 0) return null;
	// Walk up from the divider, stopping at the next border so a composer-present screen exposes only
	// the composer row. Blank rows do not spend budget; a wrapped headline needs the full allowance.
	const above: string[] = [];
	for (let i = divider - 1; i >= 0 && above.length < LIMIT_WINDOW_ROWS; i--) {
		const line = lines[i];
		if (TITLED_BORDER_RE.test(line.trim())) break;
		if (line.trim() === "") continue;
		above.push(line);
	}
	// Grow the join upward a row at a time and take the first size that matches. A single-row headline
	// therefore stays clean, while a wrapped one is rejoined far enough to recover a suffix that landed
	// on a continuation row, without swallowing the unrelated transcript above it. Rows join on a space
	// because the renderer wraps on word boundaries and drops the break itself.
	for (let take = 1; take <= above.length; take++) {
		const headline = above
			.slice(0, take)
			.reverse()
			.map((line) => line.trim())
			.join(" ");
		if (!LIMIT_HEADLINE_RE.test(headline)) continue;
		const dot = headline.indexOf("·");
		return { headline, detail: dot < 0 ? null : headline.slice(dot + 1).trim() || null };
	}
	return null;
}
