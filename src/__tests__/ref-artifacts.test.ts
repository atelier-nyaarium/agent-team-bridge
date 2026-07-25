import { describe, expect, it } from "vitest";
import { buildArtifacts, MAX_FILE_BYTES, type ResolvedRef } from "../mcp/references/artifactBuilder.js";
import { MANIFEST_FILENAME, MANIFEST_MARKER, safeName, uniqueName } from "../mcp/references/artifactNames.js";
import type { Resolution } from "../mcp/references/refResolver.js";

////////////////////////////////
//  Functions & Helpers

function ref(refPath: string, text: string, resolution: Partial<Resolution> = {}): ResolvedRef {
	const key = `ref://${refPath}${resolution.startLine ? `:S${resolution.startLine}` : ""}`;
	return {
		found: { ref: { path: refPath, segments: [], matcher: null }, key, raw: key },
		refPath,
		text,
		resolution: { startLine: 1, endLine: text.split("\n").length, quality: "exact", ...resolution },
	};
}

function lines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

/** A file comfortably over the per-file cap. */
function hugeFile(): string {
	return lines(Math.ceil(MAX_FILE_BYTES / 10) + 500, "x".repeat(20));
}

////////////////////////////////
//  Tests

describe("building the artifact set", () => {
	it("ships a manifest first, so no later file can be adopted in its place", () => {
		const result = buildArtifacts([ref("src/app.ts", "const a = 1;\n")], []);

		expect(result.ok).toBe(true);
		expect(result.ok && result.artifacts[0].filename).toBe(MANIFEST_FILENAME);
		expect(result.ok && result.artifacts[0].content).toContain(MANIFEST_MARKER);
	});

	it("ships one snapshot per file however many refs point into it", () => {
		const text = lines(40);
		const result = buildArtifacts(
			[
				ref("src/app.ts", text, { startLine: 3, endLine: 5 }),
				ref("src/app.ts", text, { startLine: 20, endLine: 22 }),
			],
			[],
		);

		expect(result.ok && result.artifacts).toHaveLength(2);
		expect(result.ok && result.manifest.files).toHaveLength(1);
		expect(result.ok && Object.keys(result.manifest.refs)).toHaveLength(2);
	});

	it("records each ref's range and quality for the viewer's banner", () => {
		const result = buildArtifacts(
			[ref("a.ts", lines(10), { startLine: 4, endLine: 6, quality: "fuzzy", reason: "renamed" })],
			[],
		);

		const entry = result.ok && Object.values(result.manifest.refs)[0];

		expect(entry).toMatchObject({ startLine: 4, endLine: 6, quality: "fuzzy", reason: "renamed" });
	});

	it("carries the ambiguity count through, so the viewer can say 1 of N", () => {
		const result = buildArtifacts([ref("a.ts", lines(10), { ambiguous: true, matchCount: 3 })], []);

		expect(result.ok && Object.values(result.manifest.refs)[0]).toMatchObject({ ambiguous: true, matchCount: 3 });
	});
});

describe("naming snapshots the way the phone will", () => {
	it("records the name the file will actually land under, not the path it came from", () => {
		const result = buildArtifacts([ref("src/deep/app.ts", "x\n")], []);

		expect(result.ok && result.manifest.files[0].filename).toBe("app.ts");
	});

	it("dedupes against the agent's own attachments, not just against other snapshots", () => {
		const result = buildArtifacts([ref("src/app.ts", "x\n")], ["app.ts"]);

		expect(result.ok && result.manifest.files[0].filename).toBe("app-1.ts");
	});

	it("dedupes two source files that sanitize to one basename", () => {
		const result = buildArtifacts([ref("a/app.ts", "x\n"), ref("b/app.ts", "y\n")], []);

		expect(result.ok && result.manifest.files.map((f) => f.filename)).toEqual(["app.ts", "app-1.ts"]);
	});

	it("refuses an attachment claiming the reserved manifest name", () => {
		const result = buildArtifacts([ref("a.ts", "x\n")], [MANIFEST_FILENAME]);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("reserved");
	});

	it("refuses it even when the collision only appears after sanitizing", () => {
		const result = buildArtifacts([ref("a.ts", "x\n")], [`/tmp/evil/${MANIFEST_FILENAME}`]);

		expect(result.ok).toBe(false);
	});
});

describe("staying inside the size caps", () => {
	it("snippets an oversized file that a ref narrows, keeping original line numbers", () => {
		const text = hugeFile();
		const result = buildArtifacts([ref("big.ts", text, { startLine: 900, endLine: 910 })], []);

		expect(result.ok).toBe(true);
		const entry = result.ok ? result.manifest.files[0] : undefined;
		expect(entry?.mode).toBe("snippet");
		expect(entry?.segments?.[0].startLine).toBe(897);
		expect(entry?.totalLines).toBe(text.split("\n").length);
	});

	it("merges two nearby refs into one segment rather than shipping the lines twice", () => {
		const text = hugeFile();
		const result = buildArtifacts(
			[
				ref("big.ts", text, { startLine: 100, endLine: 104 }),
				ref("big.ts", text, { startLine: 106, endLine: 110 }),
			],
			[],
		);

		expect(result.ok && result.manifest.files[0].segments).toHaveLength(1);
	});

	it("keeps distant refs as separate segments, so the viewer can elide between them", () => {
		const text = hugeFile();
		const result = buildArtifacts(
			[
				ref("big.ts", text, { startLine: 100, endLine: 104 }),
				ref("big.ts", text, { startLine: 900, endLine: 904 }),
			],
			[],
		);

		expect(result.ok && result.manifest.files[0].segments).toHaveLength(2);
	});

	it("refuses an oversized file a bare path cannot narrow, and says what to do", () => {
		const result = buildArtifacts([ref("big.ts", hugeFile())], []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("add a scope or #matcher");
	});

	it("refuses when a matcher-miss fallback covers the whole oversized file", () => {
		const text = hugeFile();
		const total = text.split("\n").length;
		const result = buildArtifacts(
			[ref("big.ts", text, { startLine: 1, endLine: total, quality: "fuzzy", reason: "matcher-miss" })],
			[],
		);

		expect(result.ok).toBe(false);
	});

	it("refuses a single referenced region that is itself over the cap", () => {
		const text = hugeFile();
		const total = text.split("\n").length;
		const result = buildArtifacts([ref("big.ts", text, { startLine: 2, endLine: total - 1 })], []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("smaller region");
	});
});

describe("the phone-safe name rules", () => {
	it("keeps only the basename, so a path cannot steer where the file lands", () => {
		expect(safeName("../../etc/passwd")).toBe("passwd");
		expect(safeName("C:\\Windows\\notes.txt")).toBe("notes.txt");
	});

	it("replaces characters the device will not accept", () => {
		expect(safeName("my file (v2).ts")).toBe("my_file__v2_.ts");
	});

	it("never produces a dotfile or an empty name", () => {
		expect(safeName("...")).toBe("file");
		expect(safeName(".env")).toBe("env");
	});

	it("caps the length the same way the device does", () => {
		expect(safeName(`${"a".repeat(200)}.ts`)).toHaveLength(120);
	});

	it("suffixes before the extension so the file type survives deduping", () => {
		const used = new Set(["app.ts"]);

		expect(uniqueName("app.ts", used)).toBe("app-1.ts");
		expect(uniqueName("app.ts", used)).toBe("app-2.ts");
	});
});
