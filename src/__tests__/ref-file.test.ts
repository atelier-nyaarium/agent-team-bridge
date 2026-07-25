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
	fs.writeFileSync(path.join(outside, "notes.txt"), "outside the project\n");
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

describe("resolving a path the way a shell would", () => {
	it("reads an absolute path", () => {
		expect(load(path.join(outside, "notes.txt")).ok).toBe(true);
	});

	it("reads a path that walks out with ..", () => {
		expect(load("../elsewhere/notes.txt").ok).toBe(true);
	});

	it("reads a .. buried mid-path, not just a leading one", () => {
		expect(load("src/../../elsewhere/notes.txt").ok).toBe(true);
	});

	it("reads ~/ from the owner's home", () => {
		const name = `ref-home-${process.pid}.txt`;
		fs.writeFileSync(path.join(os.homedir(), name), "home file\n");
		try {
			expect(load(`~/${name}`).ok && load(`~/${name}`).ok).toBe(true);
		} finally {
			fs.rmSync(path.join(os.homedir(), name), { force: true });
		}
	});

	it("treats ~user as a literal directory name rather than half-expanding it", () => {
		// It resolves under the project like any other name, so it simply does not exist here. Guessing
		// at another account's home would be a different file than either reading says.
		expect(load("~someone/notes.txt")).toMatchObject({ ok: false, failure: "missing" });
	});

	it("follows a symlink that lands outside the project", () => {
		fs.symlinkSync(path.join(outside, "notes.txt"), path.join(root, "src", "alias.txt"));

		expect(load("src/alias.txt").ok).toBe(true);
	});
});

describe("refusing what is a secret rather than code", () => {
	it("refuses a dotenv file, in the project like anywhere else", () => {
		fs.writeFileSync(path.join(root, ".env"), "TOKEN=hunter2\n");

		expect(load(".env")).toMatchObject({ ok: false, failure: "sensitive" });
	});

	it("refuses a suffixed dotenv (.env.production) too", () => {
		fs.writeFileSync(path.join(root, ".env.production"), "TOKEN=hunter2\n");

		expect(load(".env.production")).toMatchObject({ ok: false, failure: "sensitive" });
	});

	it("refuses anything under an .ssh directory", () => {
		fs.mkdirSync(path.join(outside, ".ssh"), { recursive: true });
		fs.writeFileSync(path.join(outside, ".ssh", "id_ed25519"), "PRIVATE KEY\n");

		expect(load(path.join(outside, ".ssh", "id_ed25519"))).toMatchObject({ ok: false, failure: "sensitive" });
	});

	it("refuses a key file by extension", () => {
		fs.writeFileSync(path.join(root, "src", "server.pem"), "CERT\n");

		expect(load("src/server.pem")).toMatchObject({ ok: false, failure: "sensitive" });
	});

	it("judges the symlink's TARGET, so an innocent name cannot smuggle a key out", () => {
		fs.mkdirSync(path.join(outside, ".ssh"), { recursive: true });
		fs.writeFileSync(path.join(outside, ".ssh", "id_rsa"), "PRIVATE KEY\n");
		fs.symlinkSync(path.join(outside, ".ssh", "id_rsa"), path.join(root, "src", "notes.ts"));

		expect(load("src/notes.ts")).toMatchObject({ ok: false, failure: "sensitive" });
	});

	it("does not refuse an ordinary file whose name merely contains env", () => {
		fs.writeFileSync(path.join(root, "src", "environment.ts"), "export const env = 1;\n");

		expect(load("src/environment.ts").ok).toBe(true);
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
