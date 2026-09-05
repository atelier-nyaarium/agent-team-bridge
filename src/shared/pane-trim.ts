////////////////////////////////
//  Constants

// Codepoint-constructed rather than a literal, so no raw control byte sits in the source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

////////////////////////////////
//  Functions & Helpers

// The capture-side half of the end-of-line padding rule. `capture-pane -J` is what puts the padding
// there: tmux(1) says "-N preserves trailing spaces at each line's end and -J preserves trailing
// spaces and joins any wrapped lines", and the join is what makes a wrapped URL copy as one string.
// So most rows arrive filled out to the pane edge with cells carrying nothing.
//
// The console runs the same rule at render (TerminalAnsi.kt's trimLineEnds) and MUST keep doing so:
// the daemon and the console update on separate triggers with no negotiation, so an older daemon
// still feeds a newer console padded frames. This is a payload cut, not a relocation. Trimming is
// idempotent, so the two sides agree by construction rather than by staying in step.

/**
 * Drop end-of-line padding from a `capture-pane -e -J` snapshot, keeping every escape byte.
 *
 * Trailing spaces are dropped only while they are INVISIBLE: a cell painted by a background, or by
 * reverse (which paints one from the foreground), colours out to the pane edge and is content rather
 * than padding. A colour-blind strip looks right on almost every row and is still wrong - a Claude
 * pane measured while writing this had 24 padded rows of which exactly one had to be kept.
 *
 * Only space CHARACTERS are removed; the SGR escapes among them stay put, so the colour state a
 * later row inherits is byte-identical to what tmux emitted. Pure, unit-testable, and the twin of
 * TerminalAnsi.kt's trimLineEnds - the two are held to the same cases in both suites.
 */
export function trimPaneRowPadding(ansi: string): string {
	// Positions of the trailing unpainted spaces of the row being scanned. Cleared the moment
	// anything else lands, so at a row's end it holds exactly what may go.
	const tail: number[] = [];
	// Ascending by construction: rows scan in order and each tail is already sorted.
	const cut: number[] = [];
	let bg = false;
	let reverse = false;

	const endRow = (): void => {
		for (const at of tail) cut.push(at);
		tail.length = 0;
	};

	// SGR only. Extended colours are walked by ARITY rather than by value, or a `38;5;48` foreground
	// reads its own colour index as a background and pins the whole row as visible.
	const applySgr = (params: number[]): void => {
		if (params.length === 0) {
			bg = false;
			reverse = false;
			return;
		}
		for (let k = 0; k < params.length; k++) {
			const code = params[k];
			if (code === 0) {
				bg = false;
				reverse = false;
			} else if (code === 7) {
				reverse = true;
			} else if (code === 27) {
				reverse = false;
			} else if (code === 49) {
				bg = false;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bg = true;
			} else if (code === 38 || code === 48) {
				if (code === 48 && (params[k + 1] === 5 || params[k + 1] === 2)) bg = true;
				if (params[k + 1] === 5) k += 2;
				else if (params[k + 1] === 2) k += 4;
			}
		}
	};

	let i = 0;
	while (i < ansi.length) {
		const c = ansi[i];
		if (c === ESC && ansi[i + 1] === "[") {
			// Scan to the CSI final byte (0x40-0x7E); param and intermediate bytes are all below it.
			let j = i + 2;
			while (j < ansi.length && ansi[j] < "@") j++;
			// An empty or non-numeric param is DROPPED, not read as 0, matching the Kotlin parser's
			// mapNotNull. Reading "" as 0 would turn a stray `[1;;7m` into a reset and clear a live
			// background, which is the one way the two rules could disagree on a real row.
			if (ansi[j] === "m") {
				applySgr(
					ansi
						.slice(i + 2, j)
						.split(";")
						.filter((p) => p !== "")
						.map(Number)
						.filter(Number.isInteger),
				);
			}
			i = j < ansi.length ? j + 1 : ansi.length;
			continue;
		}
		if (c === ESC && ansi[i + 1] === "]") {
			// OSC (an OSC 8 hyperlink), terminated by BEL or ST. Opaque: its payload is not pane text,
			// so a space inside it is never padding.
			let j = i + 2;
			while (j < ansi.length) {
				if (ansi[j] === BEL) {
					j++;
					break;
				}
				if (ansi[j] === ESC && ansi[j + 1] === "\\") {
					j += 2;
					break;
				}
				j++;
			}
			i = j;
			continue;
		}
		if (c === ESC) {
			i++;
			continue;
		}
		if (c === "\n") {
			endRow();
			i++;
			continue;
		}
		if (c === " " && !bg && !reverse) tail.push(i);
		else tail.length = 0;
		i++;
	}
	endRow();

	if (cut.length === 0) return ansi;
	let out = "";
	let from = 0;
	for (const at of cut) {
		out += ansi.slice(from, at);
		from = at + 1;
	}
	return out + ansi.slice(from);
}
