////////////////////////////////
//  Interfaces & Types

export interface LimitNotice {
	/** The matched headline, rejoined across wrap rows. Null when it has already scrolled off the pane,
	 * which is common: the dialog is pinned to the bottom and the transcript above it is whatever was
	 * on screen. Never load-bearing - the dialog itself is what proves the session is blocked. */
	headline: string | null;
	/** Everything after the headline's first middle dot, e.g. "resets 5pm". Null without a headline. */
	detail: string | null;
}

////////////////////////////////
//  Functions & Helpers

// Pure classifiers over a captured tmux pane: what state the agent's REPL screen shows. The daemon's
// wake/readiness path reaches them through tmuxCore.ts's re-export; presenceScheduler.ts imports this
// module directly, so a consumer sweep has to check both. The Kotlin twin lives in
// android/.../AgentScreen.kt - keep the markers in lockstep, and delete on both sides together: a
// classifier here costs a matching one there whether or not anything calls it.

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

// A rule row for the usage-limit check. Spans Box Drawing AND Block Elements (U+2500-U+259F): the
// limit dialog's own divider is U+2594, a block element, so a Box-Drawing-only range matches nothing
// on a real pane and detection never starts. TITLED_BORDER_RE is the same run leading a row that
// also carries text, which the composer's top border does once a session has a name.
const ANY_RULE_RE = /^[─-▟]+$/u;
const TITLED_BORDER_RE = /^[─-▟]{3,}/u;
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
// Rows to read above the divider. Panes are pinned narrow, where a short reset-time headline
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

/** The usage-limit dialog, i.e. the agent has stopped and cannot progress until the choice is answered.
 * Returns the headline and the text after its middle dot, or null.
 *
 * The DIALOG is the signal, never the headline. Both below-divider markers are required: an indented
 * numbered menu, and that dialog's own wait-for-reset choice. Neither is sufficient alone, since the
 * dialog title is reused by unrelated dialogs and a numbered menu is just as present on a permission
 * prompt, but together they appear nowhere else. Once the choice is answered the menu goes with it, so
 * the notice clears itself with no state to expire.
 *
 * The headline is read only to enrich the notice and is frequently absent: the dialog is pinned to the
 * bottom of the pane, so whatever sits above it is whatever happened to be on screen, and the headline
 * has usually scrolled past. Requiring it missed the common case entirely.
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
	// Blocked regardless: the dialog is up, the headline just is not on screen to say why.
	return { headline: null, detail: null };
}
