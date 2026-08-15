import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "src", "federation-server");
const ENTRY = path.join(REPO_ROOT, "src", "main-federation.ts");

/** The sole owner of the node HTTP types and of the one unobserved launch. */
const ADAPTER = path.join(SERVER_DIR, "routerServer.ts");

/** Spelled out rather than imported: a needle built from the value under test cannot notice it change. */
const NODE_HTTP_TYPES = /\bServerResponse\b|\bIncomingMessage\b|from "node:http"/;

/** The one launch the seam sanctions, matched on its full text so an edit to it shows in the diff. */
const SANCTIONED = "routerServer.ts: void this.serve(request, response);";

////////////////////////////////
//  Functions & Helpers

/** Fluent chains wrap across lines, and a continuation read alone looks like a bare `.then(`.
 * Folding them back onto their opening line is what lets the rules below judge whole statements. */
function logicalLines(source: string): string[] {
	const out: string[] = [];
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (line.startsWith(".") && out.length) out[out.length - 1] += line;
		else out.push(line);
	}
	return out;
}

/** True when the statement's value goes somewhere: awaited, returned, bound, or assigned. */
function isHeld(line: string): boolean {
	return /^(await|return|yield)\b/.test(line) || /^(const|let|var)\s/.test(line) || /^[\w.$[\]]+\s*=[^=]/.test(line);
}

/** True when the `.then(` on this line carries a rejection arm (a top-level second argument). */
function thenHasRejectionArm(line: string): boolean {
	const start = line.indexOf(".then(");
	if (start === -1) return false;
	let depth = 0;
	for (let i = start + ".then(".length - 1; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return false;
		} else if (ch === "," && depth === 1) return true;
	}
	// An unclosed call continues onto later lines, where the arm may still appear.
	return depth > 0;
}

/** Statement-position promise work with nobody holding the result. Structural, not type-aware:
 * it reads a file's own `async` declarations, so a call into another module is out of reach. */
function floatingLaunches(source: string): string[] {
	const asyncNames = new Set<string>();
	for (const match of source.matchAll(/\basync\s+(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
		asyncNames.add(match[1]);
	}
	const found: string[] = [];
	for (const line of logicalLines(source)) {
		if (line.startsWith("//") || line.startsWith("*")) continue;
		// The void idiom, any callee spelling.
		if (/(^|[^\w.])void\s+[A-Za-z_$]/.test(line)) {
			found.push(line);
			continue;
		}
		// An async callback handed to an emitter: its rejection has no owner.
		if (/\.(on|once)\(\s*["'`][^"'`]+["'`]\s*,\s*async\b/.test(line)) {
			found.push(line);
			continue;
		}
		if (isHeld(line)) continue;
		if (/\.then\(/.test(line) && !/\.catch\(/.test(line) && !thenHasRejectionArm(line)) {
			found.push(line);
			continue;
		}
		// A bare statement-position call to something this file declared async, chaining nowhere.
		const bare = line.match(/^(?:this\.)?([A-Za-z_$][\w$]*)\s*\(/);
		if (bare && asyncNames.has(bare[1]) && line.endsWith(";") && !/\)\s*\./.test(line)) found.push(line);
	}
	return found;
}

function scannedFiles(): string[] {
	const dir = fs
		.readdirSync(SERVER_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => path.join(SERVER_DIR, name));
	return [...dir, ENTRY];
}

function offendingLines(file: string, pattern: RegExp): string[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => pattern.test(line) && !line.trimStart().startsWith("//"));
}

////////////////////////////////
//  Tests

describe("floatingLaunches", () => {
	// The detector is the thing that can rot silently, so it is held against samples first.
	it("catches every shape the seam forbids", () => {
		const bad = [
			"work();",
			"this.work();",
			"void Promise.all([work()]);",
			"void Bun.write(p, b);",
			"void this.serve(a, b);",
			'ws.on("message", async (data) => handle(data));',
			"work().then(() => {});",
		].join("\n");
		const source = `async function work() {}\nasync serve(a, b) {}\n${bad}`;
		expect(floatingLaunches(source)).toHaveLength(7);
	});

	it("passes work that is held", () => {
		const source = [
			"async function work() {}",
			"await work();",
			"return work();",
			"const p = work();",
			"work().catch(noop);",
			"work().then(ok, err);",
			"void 0;",
		].join("\n");
		expect(floatingLaunches(source)).toEqual([]);
	});
});

describe("federation router launch seam", () => {
	it("keeps the node HTTP types inside the adapter", () => {
		for (const file of scannedFiles()) {
			if (file === ADAPTER) continue;
			expect({ file, lines: offendingLines(file, NODE_HTTP_TYPES) }).toEqual({ file, lines: [] });
		}
	});

	it("proves the adapter is the positive control", () => {
		expect(offendingLines(ADAPTER, NODE_HTTP_TYPES).length).toBeGreaterThan(0);
	});

	it("launches unobserved work in exactly one place", () => {
		const launches = scannedFiles().flatMap((file) =>
			floatingLaunches(fs.readFileSync(file, "utf8")).map((line) => `${path.basename(file)}: ${line}`),
		);
		expect(launches).toEqual([SANCTIONED]);
	});
});
