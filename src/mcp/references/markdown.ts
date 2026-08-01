import fs from "node:fs";
import path from "node:path";
import { pluginRoot } from "../../shared/plugin-root.js";

////////////////////////////////
//  Interfaces & Types

interface MarkdownToken {
	type: string;
	children?: MarkdownToken[] | null;
	attrGet(name: string): string | null;
}

interface MarkdownParser {
	parse(src: string, env: Record<string, unknown>): MarkdownToken[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * The console's own renderer, loaded from the console's own asset.
 *
 * Not an npm copy, and not a hand-written approximation. The console decides what is a link and what
 * is code when it renders; this side decides what gets a snapshot attached. Those two answers have
 * to agree, and the only way to guarantee agreement rather than hope for it is to run the same
 * bytes. A second implementation, however careful, disagrees at the edges: pairing backticks by hand
 * across a whole message silently swallowed every ref between two unrelated ones, and no amount of
 * patching that would have made it the same parser.
 */
const VENDORED_PARSER = path.join(
	pluginRoot(),
	"android",
	"app",
	"src",
	"main",
	"assets",
	"thread",
	"vendor",
	"markdown-it.min.js",
);

/**
 * Kept identical to the options in `thread.js`, which is the file this parser is borrowed from.
 *
 * `linkify: false` is the load-bearing one: only an explicitly written `[label](url)` becomes a
 * link, so a bare `ref://...` mentioned in prose is text and attaches nothing. `html: false` keeps a
 * raw anchor tag from being a link token. `breaks` does not affect link tokens but is matched anyway,
 * since the point of this file is that nothing about the two configurations differs.
 */
const OPTIONS = { html: false, breaks: true, linkify: false };

let parser: MarkdownParser | null = null;

/**
 * Evaluate the vendored bundle as CommonJS.
 *
 * `require` refuses it: this package is `type: module`, so a `.js` file inside it is treated as ESM,
 * and the bundle is UMD. Copying it to a `.cjs` name would give two sets of bytes to keep in step,
 * which is the drift this file exists to remove, so it is read and evaluated instead. The bundle
 * takes its CommonJS branch when handed a module object and never touches `window`.
 */
function load(): MarkdownParser {
	if (parser) return parser;

	const shim = { exports: {} as unknown };
	new Function("module", "exports", fs.readFileSync(VENDORED_PARSER, "utf8"))(shim, shim.exports);
	parser = (shim.exports as (opts: unknown) => MarkdownParser)(OPTIONS);
	return parser;
}

/**
 * Every link destination in a message body, in document order, as the console will see them.
 *
 * Duplicates are kept: deduplication is the caller's job, and it dedupes on canonical key rather
 * than on the written string.
 */
export function linkDestinations(body: string): string[] {
	const destinations: string[] = [];

	const walk = (tokens: MarkdownToken[] | null | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "link_open") {
				const href = token.attrGet("href");
				if (href !== null) destinations.push(href);
			}
			walk(token.children);
		}
	};

	walk(load().parse(body, {}));
	return destinations;
}
