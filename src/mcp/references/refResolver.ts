import { Language, type Node, Parser } from "web-tree-sitter";
import { grammarForPath, grammarWasmPath, treeSitterWasmPath } from "./grammarSources.js";
import type { Matcher, Ref } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

/** The resolution tier NEVER hard-fails: a drifted file still opens, with a banner. */
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

/** Cached per process: each wasm is megabytes. */
async function parserFor(grammarId: string): Promise<Parser> {
	const cached = parsers.get(grammarId);
	if (cached) return cached;

	// The library's default looks in node_modules, which the bundle has no copy of.
	await Parser.init({ locateFile: () => treeSitterWasmPath() });
	const parser = new Parser();
	parser.setLanguage(await Language.load(grammarWasmPath(grammarId)));
	parsers.set(grammarId, parser);
	return parser;
}

/**
 * Splitting on `::` and `.` lets one node match a RUN of segments: `namespace A.B`, `namespace A::B`,
 * and an out-of-line `void A::B::method()` have no nested scope nodes to walk. No identifier in these
 * languages contains either separator.
 */
function nameParts(node: Node): string[] {
	const named = node.childForFieldName("name") ?? qualifiedDeclarator(node);
	if (!named) return [];
	return named.text.split(/::|\./).filter((p) => p !== "");
}

/** In C-family code the declarator carries the qualification, not the definition node. */
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
 * Two declarations name a scope whose members are not their children. A C# file-scoped namespace has
 * no body, so everything after it belongs to it; a GDScript `class_name X` names the whole FILE.
 *
 * Their own subtree dead-ends on a bare identifier, and the ref then degrades to a text match on the
 * first CALL of the method, which reads as plausible rather than as a miss.
 */
function searchAreas(node: Node): Node[] {
	if (node.type === "class_name_statement") return [node.parent ?? node];
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

	// The node's OWN list only: a subtree search would bind a class to a nested method's parameters
	// and call it exact.
	const value = node.childForFieldName("value");
	return value?.childForFieldName("parameters") ?? null;
}

interface Branch {
	node: Node;
	/** Per-branch, never shared: a compound-name match advances only its own cursor. */
	consumed: number;
	/** Inside a parameter list, where the next segment names a parameter rather than a scope. */
	inParameters?: boolean;
}

/**
 * Every branch satisfying the scope chain.
 *
 * A segment matches any DESCENDANT, so anonymous closures in between need no naming. An intermediate
 * segment keeps ALL same-named nodes, which is what resolves a re-opened namespace, a partial class,
 * and an overload set.
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

			// A parameter is a bare identifier, so it matches a leaf by text.
			if (branch.inParameters) {
				for (const leaf of leavesNamed(branch.node, remaining[0])) {
					next.push({ node: leaf, consumed: branch.consumed + 1 });
				}
				continue;
			}

			for (const area of searchAreas(branch.node)) {
				// The branch's own node is excluded, or a segment could match it again and never advance.
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
 * How many leading segments this name consumes, or 0.
 *
 * A qualified name matches either spelling: `namespace Acme.Services` answers `:Acme:Services` and
 * `:Acme.Services` alike. Accepting only the split form failed the ref an author would write, and
 * failed it to `fuzzy` rather than to an error.
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

/** Shallowest first, then document order. On position alone a nested declaration outranks the
 * top-level one someone meant, and reports itself exact. */
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

/** Every miss degrades rather than failing: the scope stays the range and the reason names what was
 * not found, so a stale matcher still opens in the right neighbourhood. */
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
				// The start was found, so open there rather than the whole scope.
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

/** The fuzzy tier, reached when the AST could not satisfy the chain or the file has no grammar. */
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
 * Always produces a range. Tiers in order: the AST satisfies the chain, else the segment text is
 * found as a plain string, else the whole file. Hard failure lives in the file tier alone.
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
