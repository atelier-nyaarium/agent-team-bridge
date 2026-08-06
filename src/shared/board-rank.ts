////////////////////////////////
//  Fractional ranks for task-board ordering
//
//  A rank is a string over DIGITS whose PLAIN STRING ORDER is the sibling order, so a drop between
//  two neighbours mints a value between theirs and renumbers nobody. Kotlin will need a twin for
//  console-side drags; keep this module dependency-free so the two stay comparable.

////////////////////////////////
//  Constants

/** ASCII-ordered, so lexicographic string comparison and digit-value comparison agree. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Hard bound mirrored by the wire schema's .max() - same-gap insertion grows a rank forever, and
 * every rank re-ships in every snapshot. Callers rebalance the sibling range instead of exceeding. */
export const RANK_MAX_LENGTH = 64;

////////////////////////////////
//  Functions & Helpers

/** True for a mintable rank: non-empty, in-alphabet, no trailing MIN digit (a trailing "0" adds no
 * order and would break midpoint's termination guarantees). */
export function isValidRank(rank: string): boolean {
	if (rank.length === 0 || rank.length > RANK_MAX_LENGTH) return false;
	if (rank.endsWith(DIGITS[0])) return false;
	for (const ch of rank) if (!DIGITS.includes(ch)) return false;
	return true;
}

/** Mint a rank strictly between two neighbours; either end may be undefined for the open start or
 * end. Throws when the gap does not exist (before >= after) - a caller bug, never data. */
export function rankBetween(before: string | undefined, after: string | undefined): string {
	const a = before ?? "";
	if (after !== undefined && a >= after) throw new Error(`rankBetween: no gap between "${a}" and "${after}"`);
	return midpoint(a, after);
}

/** Evenly spaced fresh ranks for `count` siblings, sorted ascending. The rebalance target when a
 * mint would exceed RANK_MAX_LENGTH: every sibling gets one of these in its current order. */
export function rebalanceRanks(count: number): string[] {
	if (count <= 0) return [];
	const base = DIGITS.length;
	// The narrowest digit width whose slot space fits every sibling (62^3 already covers 238k, so
	// widths stay tiny at any realistic board size).
	let width = 1;
	let slots = base;
	while (slots <= count + 1) {
		width++;
		slots *= base;
	}
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		let slot = Math.floor(((i + 1) * slots) / (count + 1));
		let rank = "";
		for (let d = 0; d < width; d++) {
			rank = DIGITS[slot % base] + rank;
			slot = Math.floor(slot / base);
		}
		out.push(rank.replace(/0+$/, ""));
	}
	// Trailing-zero stripping cannot collide adjacent slots when every gap is >= 1 full slot, and
	// every rank is width-bounded; assert both rather than trust the arithmetic.
	for (let i = 0; i < out.length; i++) {
		if (!isValidRank(out[i])) throw new Error(`rebalanceRanks minted an invalid rank "${out[i]}"`);
		if (i > 0 && out[i - 1] >= out[i]) throw new Error("rebalanceRanks produced a non-increasing pair");
	}
	return out;
}

/** The classic fractional-indexing midpoint: a strictly-between key with no trailing MIN digit,
 * where `b === undefined` is positive infinity. */
function midpoint(a: string, b: string | undefined): string {
	if (b !== undefined) {
		let n = 0;
		while ((a[n] ?? DIGITS[0]) === b[n]) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const digitA = a ? DIGITS.indexOf(a[0]) : 0;
	const digitB = b !== undefined ? DIGITS.indexOf(b[0]) : DIGITS.length;
	if (digitB - digitA > 1) {
		return DIGITS[Math.round((digitA + digitB) / 2)];
	}
	if (b !== undefined && b.length > 1) return b[0];
	return DIGITS[digitA] + midpoint(a.slice(1), undefined);
}
