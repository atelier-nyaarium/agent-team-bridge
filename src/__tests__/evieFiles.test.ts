import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EVIE_FILES_DIR,
	type MaterializeFilesParams,
	materializeFiles,
	renderFilesBlock,
	safeFilename,
} from "../mcp/channel/evieFiles.js";
import type { ChannelFile } from "../shared/types.js";

const createdBuckets: string[] = [];

function uniqueId(): string {
	const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	createdBuckets.push(id);
	return id;
}

afterEach(() => {
	while (createdBuckets.length > 0) {
		const id = createdBuckets.pop()!;
		rmSync(join(EVIE_FILES_DIR, id), { recursive: true, force: true });
	}
});

describe("safeFilename", () => {
	it("strips path separators, leading dots, control chars; preserves unicode and spaces", () => {
		expect(safeFilename("../../etc/passwd")).toBe("passwd");
		expect(safeFilename(".hidden.png")).toBe("hidden.png");
		expect(safeFilename("a\x00b\x1fc.txt")).toBe("abc.txt");
		expect(safeFilename("猫 picture.png")).toBe("猫 picture.png");
	});

	it("falls back to 'file' when sanitization empties the name", () => {
		expect(safeFilename("....")).toBe("file");
		expect(safeFilename("/")).toBe("file");
	});

	it("caps the result at 200 utf-8 bytes", () => {
		const long = `${"a".repeat(500)}.png`;
		const safe = safeFilename(long);
		expect(Buffer.byteLength(safe, "utf8")).toBeLessThanOrEqual(200);
	});
});

describe("materializeFiles", () => {
	function makeFile(overrides: Partial<ChannelFile> = {}): ChannelFile {
		return {
			filename: "dog.png",
			mime: "image/png",
			size: 4,
			descriptiveKey: "The image named `dog.png`",
			base64: Buffer.from("test").toString("base64"),
			...overrides,
		};
	}

	it("writes base64-bearing files to /tmp/evie-files/<msgId>/<safeFilename>", () => {
		const id = uniqueId();
		const params: MaterializeFilesParams = { discordMessageId: id, files: [makeFile()] };
		const out = materializeFiles(params);

		expect(out).toHaveLength(1);
		expect(out[0].path).toBe(join(EVIE_FILES_DIR, id, "dog.png"));
		expect(readFileSync(out[0].path!).toString()).toBe("test");
	});

	it("metadata-only entries (no base64) get no path", () => {
		const id = uniqueId();
		const out = materializeFiles({
			discordMessageId: id,
			files: [
				makeFile({
					base64: undefined,
					mime: "application/pdf",
					filename: "doc.pdf",
					descriptiveKey: "The PDF named `doc.pdf`",
				}),
			],
		});

		expect(out).toHaveLength(1);
		expect(out[0].path).toBeUndefined();
		expect(out[0].descriptiveKey).toBe("The PDF named `doc.pdf`");
	});

	it("collision suffix appends -2, -3 within one materialize call", () => {
		const id = uniqueId();
		const out = materializeFiles({
			discordMessageId: id,
			files: [
				makeFile({ filename: "shot.png" }),
				makeFile({ filename: "shot.png" }),
				makeFile({ filename: "shot.png" }),
			],
		});

		expect(out[0].path).toBe(join(EVIE_FILES_DIR, id, "shot.png"));
		expect(out[1].path).toBe(join(EVIE_FILES_DIR, id, "shot-2.png"));
		expect(out[2].path).toBe(join(EVIE_FILES_DIR, id, "shot-3.png"));
	});

	it("path-traversal filename gets sanitized to its basename", () => {
		const id = uniqueId();
		const out = materializeFiles({
			discordMessageId: id,
			files: [makeFile({ filename: "../../etc/passwd" })],
		});

		expect(out[0].path).toBe(join(EVIE_FILES_DIR, id, "passwd"));
	});
});

describe("renderFilesBlock", () => {
	it("emits unified [FILES] block with -> /path on materialized only", () => {
		const block = renderFilesBlock({
			discordMessageId: "abc",
			files: [
				{
					descriptiveKey: "The 1st image named `dog.png`",
					path: "/tmp/evie-files/abc/dog.png",
				},
				{
					descriptiveKey: "The PDF named `doc.pdf`",
				},
			],
		});

		expect(block).toContain(`[FILES messageId="abc"]`);
		expect(block).toContain("were not transferred");
		expect(block).toContain("1. The 1st image named `dog.png` -> `/tmp/evie-files/abc/dog.png`");
		expect(block).toContain("2. The PDF named `doc.pdf`");
		expect(block).not.toContain("2. The PDF named `doc.pdf` ->");
		expect(block).toContain("[/FILES]");
	});

	it("returns empty string for empty file list", () => {
		expect(renderFilesBlock({ discordMessageId: "abc", files: [] })).toBe("");
	});

	it("opener falls back to bare [FILES] when discordMessageId is omitted", () => {
		const block = renderFilesBlock({
			files: [
				{
					descriptiveKey: "The image named `x.png`",
					path: "/tmp/x.png",
				},
			],
		});
		expect(block.startsWith("[FILES]\n")).toBe(true);
	});
});
