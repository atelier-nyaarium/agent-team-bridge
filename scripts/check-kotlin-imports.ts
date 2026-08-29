#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

interface DeadImport {
	file: string;
	line: number;
	statement: string;
}

////////////////////////////////
//  Functions & Helpers

const ANDROID_SRC = path.join(import.meta.dirname, "..", "android", "app", "src");

/** Names Kotlin resolves by convention rather than by spelling, so absence from the body proves
 * nothing. Delegate operators are invoked by `by`, and the destructuring and invoke conventions the
 * same way. */
const CONVENTION_NAMES = new Set([
	"getValue",
	"setValue",
	"provideDelegate",
	"invoke",
	"iterator",
	"compareTo",
	"contains",
	"rangeTo",
	"plus",
	"minus",
	"times",
	"div",
	"rem",
	"unaryPlus",
	"unaryMinus",
	"inc",
	"dec",
	"get",
	"set",
	"equals",
	"hashCode",
	"toString",
]);

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** The simple name an import binds, which is the alias when it has one and the last segment
 * otherwise. Null for a wildcard, whose binding cannot be checked by spelling. */
function boundName(statement: string): string | null {
	const aliased = statement.match(/^import\s+[\w.`]+\s+as\s+([\w`]+)/);
	if (aliased) return aliased[1].replaceAll("`", "");
	const plain = statement.match(/^import\s+([\w.`]+)/);
	if (!plain || plain[1].endsWith(".*")) return null;
	const segments = plain[1].replaceAll("`", "").split(".");
	return segments[segments.length - 1] ?? null;
}

/**
 * Kotlin source with comments and string TEXT removed, in ONE left-to-right scan.
 *
 * A scan rather than a sequence of replacements: `"https://x"` contains `//`, so stripping comments
 * first eats the rest of that string and leaves an unterminated quote, which then swallows real code
 * and reports live imports as dead. Only a reader that knows whether it is currently inside a string
 * gets this right.
 *
 * Text inside `${}` is kept, since a symbol used only in a template is still used.
 */
function body(source: string): string {
	const src = source
		.split("\n")
		.filter((line) => !/^\s*import\s/.test(line))
		.join("\n");
	let out = "";
	let i = 0;
	while (i < src.length) {
		const rest = src.slice(i);
		if (rest.startsWith("/*")) {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			out += " ";
		} else if (rest.startsWith("//")) {
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
			out += " ";
		} else if (rest.startsWith('"""') || src[i] === '"') {
			const quote = rest.startsWith('"""') ? '"""' : '"';
			i += quote.length;
			// Keep template expressions, drop the literal text around them.
			while (i < src.length && !src.startsWith(quote, i)) {
				if (quote === '"' && src[i] === "\\") {
					i += 2;
					continue;
				}
				if (src.startsWith("${", i)) {
					const close = src.indexOf("}", i);
					const end = close === -1 ? src.length : close + 1;
					out += ` ${src.slice(i + 2, end - 1)} `;
					i = end;
					continue;
				}
				if (quote === '"' && src[i] === "\n") break;
				i += 1;
			}
			i += src.startsWith(quote, i) ? quote.length : 0;
			out += " ";
		} else {
			out += src[i];
			i += 1;
		}
	}
	return out;
}

export function deadImports(files: string[]): DeadImport[] {
	const out: DeadImport[] = [];
	for (const file of files) {
		const source = fs.readFileSync(file, "utf8");
		const code = body(source);
		source.split("\n").forEach((line, index) => {
			if (!/^\s*import\s/.test(line)) return;
			const name = boundName(line.trim());
			if (!name || CONVENTION_NAMES.has(name)) return;
			if (new RegExp(`\\b${name}\\b`).test(code)) return;
			out.push({ file, line: index + 1, statement: line.trim() });
		});
	}
	return out;
}

////////////////////////////////
//  Entry

if (import.meta.main) {
	const files = kotlinFiles(ANDROID_SRC);
	if (files.length === 0) {
		console.error(`kotlin import check: expected Kotlin files under ${ANDROID_SRC}, but scanned none.`);
		process.exit(1);
	}
	const dead = deadImports(files);
	if (dead.length === 0) {
		console.log(`kotlin import check: clean (${files.length} files).`);
		process.exit(0);
	}
	for (const d of dead) {
		console.error(`${path.relative(process.cwd(), d.file)}:${d.line}  ${d.statement}`);
	}
	console.error(`\nkotlin import check: ${dead.length} unused import(s) across ${files.length} files.`);
	process.exit(1);
}
