////////////////////////////////
//  Functions & Helpers

// Exported: dedupLabel's `-#` suffixing in session-store.ts re-caps against this same bound, so a
// suffixed label can never exceed what sanitizeLabel itself would have allowed.
export const LABEL_MAX = 64;
// Invisible or direction-warping characters (controls, zero-width/format, bidi overrides, lone
// surrogates, private-use, unassigned) make a label unrenderable or spoofable on the board; path
// separators would let an unauthenticated register steer resolveHostWorkdir's path join. One rule
// for both risks: a label is a single, VISIBLY printable path segment. Unicode category classes
// rather than a codepoint blocklist, so new invisible characters cannot slip through.
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}/\\]/u;

/** Normalize a human-supplied label (create, rename, register cwdName): trimmed, capped, visibly
 * printable, a single path segment. Returns null when nothing safe remains. */
export function sanitizeLabel(raw: string | undefined | null): string | null {
	// Cap on CODE POINTS: a code-unit slice can split an astral character and leave an ill-formed
	// string that breaks JSON consumers downstream.
	const trimmed = [...(raw ?? "").trim()].slice(0, LABEL_MAX).join("");
	if (!trimmed || trimmed === "." || trimmed === "..") return null;
	if (LABEL_FORBIDDEN.test(trimmed)) return null;
	return trimmed;
}

const WORKDIR_PATH_MAX = 512;
// The label's forbidden classes plus the launch-command breakout set (quotes, backtick, $,
// backslash), minus "/" which is the entire point of a path.
const WORKDIR_PATH_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}'"`$\\]/u;

/** Normalize a console-picked host workdir path (create_session's workdir): trimmed, capped on
 * code points, absolute or ~-rooted, visibly printable, free of the characters that could break
 * out of the daemon's quoted launch command (see host-op.ts isWorkdirPath, the boundary twin).
 * Returns null when unusable - a truncated path would name a different directory, so an over-long
 * one is rejected rather than sliced. */
export function sanitizeWorkdirPath(raw: string | undefined | null): string | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed || [...trimmed].length > WORKDIR_PATH_MAX) return null;
	if (!trimmed.startsWith("/") && trimmed !== "~" && !trimmed.startsWith("~/")) return null;
	if (WORKDIR_PATH_FORBIDDEN.test(trimmed)) return null;
	return trimmed;
}

const DESCRIPTION_MAX = 120;
// The label's forbidden classes minus the path separators: a description is display-only prose
// (never joined into a filesystem path), so "/" is fine; invisible/direction-warping characters are
// still stripped so an LLM answer cannot render blank or spoofed on the board.
const DESCRIPTION_STRIP = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;

/** Normalize a session description arriving from a friend's Gateway: controls/invisibles
 * STRIPPED rather than rejected (an LLM phrase with a stray newline should survive as one line, not
 * vanish), whitespace collapsed, capped on code points. Returns null when nothing remains. */
export function sanitizeDescription(raw: string | undefined | null): string | null {
	const cleaned = (raw ?? "").replace(DESCRIPTION_STRIP, " ").replace(/\s+/g, " ").trim();
	const capped = [...cleaned].slice(0, DESCRIPTION_MAX).join("").trim();
	return capped || null;
}
