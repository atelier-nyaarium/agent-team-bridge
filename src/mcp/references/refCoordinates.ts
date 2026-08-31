// The one conversion between the index's ranges and the console's lines, and the home of the
// resolution a snapshot carries. Protocol ranges are 0-based and half-open over UTF-16 units of
// the decoded text; the console reads 1-based inclusive lines and 0-based columns.

import type { Position, Range } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** `exact` is one hash-verified declaration; the other two only ever come from lexicon's absence. */
export type Quality = "exact" | "fuzzy" | "unresolved";

/** A character span to highlight inside the range, in original-file coordinates. */
export interface Span {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface Resolution {
	/** 1-based, inclusive, always in ORIGINAL-file coordinates even when only a snippet ships. */
	startLine: number;
	endLine: number;
	/** Present only when the ref narrowed to specific characters rather than a whole scope. */
	span?: Span;
	quality: Quality;
	/** Why the quality is not exact, phrased for the viewer's banner. */
	reason?: string;
}

export interface Lines {
	startLine: number;
	endLine: number;
}

////////////////////////////////
//  Functions & Helpers

/** An end at character 0 closes on the previous line, so a range ending at a line start does not claim it. */
export function linesOf(range: Range): Lines {
	const startLine = range.start.line + 1;
	const closesEarly = range.end.character === 0 && range.end.line > range.start.line;
	const endLine = closesEarly ? range.end.line : range.end.line + 1;
	return { startLine, endLine: Math.max(startLine, endLine) };
}

export function spanOf(range: Range): Span {
	return {
		startLine: range.start.line + 1,
		startColumn: range.start.character,
		endLine: range.end.line + 1,
		endColumn: range.end.character,
	};
}

/** Into the decoded text, which is what the index counted as well. */
export function offsetOf(text: string, position: Position): number {
	let offset = 0;
	for (let line = 0; line < position.line; line++) {
		const next = text.indexOf("\n", offset);
		if (next === -1) return text.length;
		offset = next + 1;
	}
	return Math.min(text.length, offset + position.character);
}

export function offsetsOf(text: string, range: Range): { start: number; end: number } {
	return { start: offsetOf(text, range.start), end: offsetOf(text, range.end) };
}

/** 1-based. */
export function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
	return line;
}

/** 0-based. */
export function columnOf(text: string, index: number): number {
	// lastIndexOf clamps a negative fromIndex to 0, so at index 0 it would find a leading newline
	// and report column -1. Nothing precedes index 0.
	if (index <= 0) return 0;
	const start = text.lastIndexOf("\n", index - 1);
	return index - start - 1;
}

export function spanAt(text: string, start: number, length: number): Span {
	return {
		startLine: lineOf(text, start),
		startColumn: columnOf(text, start),
		endLine: lineOf(text, start + length),
		endColumn: columnOf(text, start + length),
	};
}

export function lineCount(text: string): number {
	return Math.max(1, text.split("\n").length);
}
