import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRefFile } from "../mcp/references/refFile.js";

////////////////////////////////
//  Functions & Helpers

let root: string;
let outside: string;

beforeEach(() => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "ref-file-"));
	root = path.join(base, "project");
	outside = path.join(base, "elsewhere");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(outside, "secrets.env"), "TOKEN=hunter2\n");
});

afterEach(() => {
	fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function load(refPath: string) {
	return loadRefFile(root, refPath);
}

////////////////////////////////
//  Tests

describe("reading a referenced file", () => {
	it("reads a project file and reports its text", () => {
		const result = load("src/app.ts");

		expect(result.ok).toBe(true);
		expect(result.ok && result.file.text).toBe("export const x = 1;\n");
	});

	it("reports a missing file rather than throwing", () => {
		const result = load("src/nope.ts");

		expect(result).toMatchObject({ ok: false, failure: "missing" });
	});

	it("refuses a directory, which is readable but not a snapshot", () => {
		expect(load("src")).toMatchObject({ ok: false, failure: "unreadable" });
	});
});

describe("staying inside the project", () => {
	it("refuses a path that walks out with ..", () => {
		expect(load("../elsewhere/secrets.env")).toMatchObject({ ok: false, failure: "escapes-project" });
	});

	it("refuses a .. buried mid-path, not just a leading one", () => {
		expect(load("src/../../elsewhere/secrets.env")).toMatchObject({ ok: false, failure: "escapes-project" });
	});

	it("refuses an absolute path", () => {
		expect(load(path.join(outside, "secrets.env"))).toMatchObject({ ok: false, failure: "escapes-project" });
	});

	it("refuses a symlink that lands outside, which the written path cannot reveal", () => {
		fs.symlinkSync(path.join(outside, "secrets.env"), path.join(root, "src", "innocent.ts"));

		expect(load("src/innocent.ts")).toMatchObject({ ok: false, failure: "escapes-project" });
	});

	it("allows a symlink that stays inside", () => {
		fs.symlinkSync(path.join(root, "src", "app.ts"), path.join(root, "src", "alias.ts"));

		expect(load("src/alias.ts").ok).toBe(true);
	});

	it("refuses a sibling directory whose name merely starts with the project's", () => {
		const sibling = `${root}-backup`;
		fs.mkdirSync(sibling, { recursive: true });
		fs.writeFileSync(path.join(sibling, "notes.txt"), "hi\n");

		expect(load("../project-backup/notes.txt")).toMatchObject({ ok: false, failure: "escapes-project" });
	});
});

describe("deciding what counts as text", () => {
	it("reads a UTF-16 source, which a naive binary sniff would reject for its NUL bytes", () => {
		const source = "export const greeting = 'hi';\n";
		fs.writeFileSync(
			path.join(root, "src", "utf16.ts"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]),
		);

		const result = load("src/utf16.ts");

		expect(result.ok && result.file.text).toBe(source);
	});

	it("reads a big-endian UTF-16 source too", () => {
		const source = "const x = 1;\n";
		const le = Buffer.from(source, "utf16le");
		fs.writeFileSync(
			path.join(root, "src", "be.ts"),
			Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]),
		);

		expect(load("src/be.ts").ok && load("src/be.ts").ok).toBe(true);
	});

	it("reports bytes in the transcoded text, so downstream size caps measure what actually ships", () => {
		const source = "const x = 1;\n";
		fs.writeFileSync(
			path.join(root, "src", "u16.ts"),
			Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]),
		);

		const result = load("src/u16.ts");

		expect(result.ok && result.file.bytes).toBe(Buffer.byteLength(source, "utf8"));
	});

	it("refuses a binary file", () => {
		fs.writeFileSync(path.join(root, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

		expect(load("src/logo.png")).toMatchObject({ ok: false, failure: "binary" });
	});

	it("refuses bytes that are not valid UTF-8, rather than shipping replacement characters", () => {
		fs.writeFileSync(path.join(root, "src", "latin.txt"), Buffer.from([0x68, 0x69, 0xff, 0xfe0, 0x0a]));

		expect(load("src/latin.txt")).toMatchObject({ ok: false, failure: "binary" });
	});

	it("accepts a plain text file with no whitelisted grammar, which is legal in the bare-path form", () => {
		fs.writeFileSync(path.join(root, "NOTES.md"), "# Notes\n");

		expect(load("NOTES.md").ok).toBe(true);
	});
});
