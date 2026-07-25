import { Language, type Node, Parser } from "web-tree-sitter";
import { grammarForPath, grammarWasmPath } from "./grammarSources.js";
import type { Matcher, Ref } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

/**
 * How much of what the ref asked for was actually found.
 *
 * The resolution tier NEVER hard-fails. A file that has drifted since the agent read it should
 * still open somewhere useful with an honest banner, because the alternative is refusing to send a
 * message over a renamed function.
 */
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
	/** Several declarations answered the final segment; the first in document order was taken. */
	ambiguous?: boolean;
	matchCount?: number;
}

////////////////////////////////
//  Functions & Helpers

const parsers = new Map<string, Parser>();

/** Grammars are loaded once per process and reused: each wasm is megabytes and a reply may carry
 * many refs into the same language. */
async function parserFor(grammarId: string): Promise<Parser> {
	const cached = parsers.get(grammarId);
	if (cached) return cached;

	await Parser.init();
	const parser = new Parser();
	parser.setLanguage(await Language.load(grammarWasmPath(grammarId)));
	parsers.set(grammarId, parser);
	return parser;
}

/**
 * The name parts a node answers to.
 *
 * Splitting on `::` and `.` is what makes one node match a RUN of ref segments: C# writes
 * `namespace A.B`, C++17 writes `namespace A::B`, and a C++ out-of-line definition writes
 * `void A::B::method()` with no nested scope nodes to walk at all. No identifier in these languages
 * legitimately contains either separator, so splitting is unambiguous.
 */
function nameParts(node: Node): string[] {
	const named = node.childForFieldName("name") ?? qualifiedDeclarator(node);
	if (!named) return [];
	return named.text.split(/::|\./).filter((p) => p !== "");
}

/** The declarator identifier of a C-family definition, which carries the qualification rather than
 * the definition node itself. */
function qualifiedDeclarator(node: Node): Node | null {
	if (node.type !== "function_definition") return null;
	let cursor: Node | null = node.childForFieldName("declarator");
	while (cursor) {
		if (cursor.type === "qualified_identifier" || cursor.type === "identifier") return cursor;
		cursor = cursor.childForFieldName("declarator");
	}
	return null;
}

/**
 * Where to keep searching after matching a node.
 *
 * A C# file-scoped namespace (`namespace Foo;`, the modern default) has no body node at all; every
 * declaration after it in the file belongs to it, so its effective body is its following siblings.
 */
function searchAreas(node: Node): Node[] {
	if (node.type !== "file_scoped_namespace_declaration") return [node];

	const parent = node.parent;
	if (!parent) return [node];
	const index = parent.children.findIndex((c) => c?.id === node.id);
	return parent.children.slice(index + 1).filter((c): c is Node => c !== null);
}

/** Every descendant of `root` that answers to a name, shallowest first then document order. */
function namedDescendants(root: Node): Node[] {
	const out: Node[] = [];
	let level: Node[] = root.namedChildren.filter((c): c is Node => c !== null);
	while (level.length > 0) {
		const next: Node[] = [];
		for (const node of level) {
			if (nameParts(node).length > 0) out.push(node);
			next.push(...node.namedChildren.filter((c): c is Node => c !== null));
		}
		level = next;
	}
	return out;
}

/** The parameter list of a scope, for the `arguments` pseudo-segment. */
function parameterList(node: Node): Node | null {
	const direct = node.childForFieldName("parameters");
	if (direct) return direct;

	const declarator = node.childForFieldName("declarator");
	const viaDeclarator = declarator?.childForFieldName("parameters");
	if (viaDeclarator) return viaDeclarator;

	// Only the node's OWN parameter list. A subtree search would silently bind a class or namespace
	// to some nested method's parameters and call it exact, which the pseudo-segment exemption
	// exists to prevent. The value form (`const f = (url) => {}`) keeps its own lookup below.
	const value = node.childForFieldName("value");
	return value?.childForFieldName("parameters") ?? null;
}

interface Branch {
	node: Node;
	/** How many of the ref's segments this branch has consumed. Per-branch, never shared: a
	 * compound-name match advances only its own cursor, and a branch that runs out of segments is a
	 * final match no matter how many its siblings went on to consume. */
	consumed: number;
	/** Inside a parameter list, where the next segment names a parameter rather than a scope. */
	inParameters?: boolean;
}

/**
 * Walk the scope chain, collecting every branch that satisfies it.
 *
 * A segment matches any DESCENDANT of the previous match, not only a direct child, so deeply nested
 * JavaScript resolves without naming the anonymous closures in between. An intermediate segment
 * keeps ALL same-named nodes and continues into the union of them, which is what makes a re-opened
 * C++ namespace, a C# partial class, and a TypeScript overload set resolve instead of failing.
 */
function walkSegments(root: Node, segments: string[]): Node[] {
	let branches: Branch[] = [{ node: root, consumed: 0 }];
	const finals: Node[] = [];

	while (branches.length > 0) {
		const next: Branch[] = [];
		for (const branch of branches) {
			const remaining = segments.slice(branch.consumed);
			if (remaining.length === 0) {
				finals.push(branch.node);
				continue;
			}

			if (remaining[0] === "arguments") {
				const params = parameterList(branch.node);
				if (params) next.push({ node: params, consumed: branch.consumed + 1, inParameters: true });
				continue;
			}

			// A parameter is a bare identifier, not a node answering to a `name` field, so inside a
			// parameter list a segment matches a leaf by its own text instead.
			if (branch.inParameters) {
				for (const leaf of leavesNamed(branch.node, remaining[0])) {
					next.push({ node: leaf, consumed: branch.consumed + 1 });
				}
				continue;
			}

			for (const area of searchAreas(branch.node)) {
				// A sibling area is itself a candidate; the branch's own node is not, or a segment
				// could match the node it already matched and never advance.
				const candidates =
					area.id === branch.node.id ? namedDescendants(area) : [area, ...namedDescendants(area)];
				for (const candidate of candidates) {
					const run = matchedRun(nameParts(candidate), remaining);
					if (run > 0) next.push({ node: candidate, consumed: branch.consumed + run });
				}
			}
		}
		if (next.length === 0) break;
		branches = next;
	}

	return finals.length > 0 ? dedupeByPosition(finals) : [];
}

/** Leaf nodes under `root` whose own text is exactly `name`, for parameter navigation. */
function leavesNamed(root: Node, name: string): Node[] {
	const out: Node[] = [];
	const visit = (node: Node) => {
		const children = node.namedChildren.filter((c): c is Node => c !== null);
		if (children.length === 0) {
			if (node.text === name) out.push(node);
			return;
		}
		for (const child of children) visit(child);
	};
	visit(root);
	return out;
}

/**
 * How many leading segments this node's name consumes, or 0 if it does not match.
 *
 * A qualified name matches either spelling: `namespace Acme.Services` answers both
 * `:Acme:Services` (a run, one segment per part) and `:Acme.Services` (one segment, written the way
 * the source writes it). Accepting only the split form silently failed the C# ref an author would
 * naturally write, and failed it to `fuzzy` rather than to an error.
 */
function matchedRun(parts: string[], remaining: string[]): number {
	if (parts.length === 0 || remaining.length === 0) return 0;
	if (parts.length <= remaining.length && parts.every((part, i) => part === remaining[i])) return parts.length;
	return parts.join(".") === remaining[0] || parts.join("::") === remaining[0] ? 1 : 0;
}

function depthOf(node: Node): number {
	let depth = 0;
	for (let cursor = node.parent; cursor; cursor = cursor.parent) depth++;
	return depth;
}

/**
 * Shallowest first, then document order. Sorting on position alone would throw away the depth the
 * walk worked to find, so a nested declaration could outrank the top-level one someone meant: in
 * this repo `ref://src/shared/crypto.ts:sign` landed on an interface field rather than the exported
 * function, and reported itself exact.
 */
function dedupeByPosition(nodes: Node[]): Node[] {
	const seen = new Map<string, Node>();
	for (const node of nodes) {
		const key = `${node.startIndex}:${node.endIndex}`;
		if (!seen.has(key)) seen.set(key, node);
	}
	return [...seen.values()].sort((a, b) => depthOf(a) - depthOf(b) || a.startIndex - b.startIndex);
}

////////////////////////////////
//  Matcher application

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
	return line;
}

function columnOf(text: string, index: number): number {
	const start = text.lastIndexOf("\n", index - 1);
	return index - start - 1;
}

function spanFor(text: string, start: number, length: number): Span {
	return {
		startLine: lineOf(text, start),
		startColumn: columnOf(text, start),
		endLine: lineOf(text, start + length),
		endColumn: columnOf(text, start + length),
	};
}

/** The occurrence of `needle` nearest before `pivot`, or -1. */
function nearestBefore(text: string, needle: string, pivot: number): number {
	return needle === "" ? -1 : text.lastIndexOf(needle, Math.max(0, pivot - needle.length));
}

/**
 * Apply a fragment inside an already-resolved scope.
 *
 * Every miss degrades rather than failing: the scope stays the range, the quality drops to fuzzy,
 * and the reason names what was not found. A ref is a pointer into a file that keeps changing, so a
 * stale matcher should still open the reader in the right neighbourhood.
 */
function applyMatcher(text: string, scopeStart: number, scopeEnd: number, matcher: Matcher): Partial<Resolution> {
	const scope = text.slice(scopeStart, scopeEnd);
	const absolute = (local: number) => scopeStart + local;

	const first = (needle: string, from = 0) => (needle === "" ? -1 : scope.indexOf(needle, from));

	switch (matcher.kind) {
		case "text": {
			const at = first(matcher.text);
			if (at === -1) return { quality: "fuzzy", reason: `no match for "${matcher.text}" in this scope` };
			return { span: spanFor(text, absolute(at), matcher.text.length), quality: "exact" };
		}
		case "before":
		case "after": {
			const anchorAt = first(matcher.anchor);
			if (anchorAt === -1) {
				return { quality: "fuzzy", reason: `anchor "${matcher.anchor}" not found in this scope` };
			}
			const at =
				matcher.kind === "before"
					? nearestBefore(scope, matcher.text, anchorAt)
					: first(matcher.text, anchorAt + matcher.anchor.length);
			if (at === -1) {
				return { quality: "fuzzy", reason: `no "${matcher.text}" ${matcher.kind} "${matcher.anchor}"` };
			}
			return { span: spanFor(text, absolute(at), matcher.text.length), quality: "exact" };
		}
		case "range": {
			const fromAt = first(matcher.from);
			if (fromAt === -1) return { quality: "fuzzy", reason: `no match for "${matcher.from}" in this scope` };
			const toAt = first(matcher.to, fromAt + matcher.from.length);
			if (toAt === -1) {
				// The range start was found, so open there rather than falling back to the whole scope.
				return {
					startLine: lineOf(text, absolute(fromAt)),
					endLine: lineOf(text, absolute(fromAt + matcher.from.length)),
					quality: "fuzzy",
					reason: `range end "${matcher.to}" not found after "${matcher.from}"`,
				};
			}
			return {
				startLine: lineOf(text, absolute(fromAt)),
				endLine: lineOf(text, absolute(toAt + matcher.to.length)),
				quality: "exact",
			};
		}
	}
}

/**
 * The fuzzy tier: find a segment's text as a plain string in the file.
 *
 * Reached when the AST could not satisfy the chain, or when the file has no whitelisted grammar at
 * all. A renamed enclosing class should not stop a reader reaching the method they were pointed at.
 */
function fuzzyLineMatch(text: string, segments: string[]): Resolution | null {
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i];
		if (segment === "arguments") continue;
		const at = text.indexOf(segment);
		if (at === -1) continue;
		return {
			startLine: lineOf(text, at),
			endLine: lineOf(text, at),
			span: spanFor(text, at, segment.length),
			quality: "fuzzy",
			reason: `could not resolve the scope chain; matched "${segment}" by text`,
		};
	}
	return null;
}

function wholeFile(text: string, reason: string): Resolution {
	return { startLine: 1, endLine: Math.max(1, text.split("\n").length), quality: "unresolved", reason };
}

/**
 * Resolve a ref against a file's text, always producing a range.
 *
 * The tiers, in order: the AST satisfies the scope chain; else the segment text is found as a plain
 * string; else the whole file. Hard failure lives entirely in the file tier (missing, binary,
 * escaping, over-cap), never here.
 */
export async function resolveRef(filePath: string, text: string, ref: Ref): Promise<Resolution> {
	const lastLine = Math.max(1, text.split("\n").length);

	if (ref.segments.length === 0 && !ref.matcher) return { startLine: 1, endLine: lastLine, quality: "exact" };

	const grammarId = grammarForPath(filePath);
	let scopeStart = 0;
	let scopeEnd = text.length;
	let ambiguity: Pick<Resolution, "ambiguous" | "matchCount"> = {};

	if (ref.segments.length > 0) {
		if (!grammarId) {
			const fuzzy = fuzzyLineMatch(text, ref.segments);
			return fuzzy ?? wholeFile(text, `no parser for this file type, and no segment matched by text`);
		}

		const parser = await parserFor(grammarId);
		const tree = parser.parse(text);
		if (!tree) return wholeFile(text, "this file could not be parsed");

		const matches = walkSegments(tree.rootNode, ref.segments);
		if (matches.length === 0) {
			const fuzzy = fuzzyLineMatch(text, ref.segments);
			return fuzzy ?? wholeFile(text, `could not find "${ref.segments.join(":")}" in this file`);
		}

		const chosen = matches[0];
		scopeStart = chosen.startIndex;
		scopeEnd = chosen.endIndex;
		if (matches.length > 1) ambiguity = { ambiguous: true, matchCount: matches.length };
	}

	const base: Resolution = {
		startLine: lineOf(text, scopeStart),
		endLine: lineOf(text, Math.max(scopeStart, scopeEnd - 1)),
		quality: "exact",
		...ambiguity,
	};

	if (!ref.matcher) return base;
	return { ...base, ...applyMatcher(text, scopeStart, scopeEnd, ref.matcher) };
}
