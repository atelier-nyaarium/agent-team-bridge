import { describe, expect, it } from "vitest";
import { buildArtifacts, MAX_FILE_BYTES, type ResolvedRef } from "../mcp/references/artifactBuilder.js";
import { safeName, uniqueName } from "../mcp/references/artifactNames.js";
import type { Resolution } from "../mcp/references/refResolver.js";
import { REF_META_MAX_KEYS } from "../shared/channel-file.js";

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
	it("ships snapshots only - no manifest file exists to adopt or forge", () => {
		const result = buildArtifacts([ref("src/app.ts", "const a = 1;\n")], []);

		expect(result.ok).toBe(true);
		expect(result.ok && result.artifacts).toHaveLength(1);
		expect(result.ok && result.artifacts[0].filename).toBe("app.ts");
	});

	it("ships one snapshot per file carrying every ref key that points into it", () => {
		const text = lines(40);
		const result = buildArtifacts(
			[
				ref("src/app.ts", text, { startLine: 3, endLine: 5 }),
				ref("src/app.ts", text, { startLine: 20, endLine: 22 }),
			],
			[],
		);

		expect(result.ok && result.artifacts).toHaveLength(1);
		expect(result.ok && result.artifacts[0].ref.keys).toHaveLength(2);
		expect(result.ok && result.artifacts[0].ref.refPath).toBe("src/app.ts");
	});

	it("records each ref's range and quality for the viewer's banner", () => {
		const result = buildArtifacts(
			[ref("a.ts", lines(10), { startLine: 4, endLine: 6, quality: "fuzzy", reason: "renamed" })],
			[],
		);

		expect(result.ok && result.artifacts[0].ref.keys[0]).toMatchObject({
			startLine: 4,
			endLine: 6,
			quality: "fuzzy",
			reason: "renamed",
		});
	});

	it("carries the ambiguity count through, so the viewer can say 1 of N", () => {
		const result = buildArtifacts([ref("a.ts", lines(10), { ambiguous: true, matchCount: 3 })], []);

		expect(result.ok && result.artifacts[0].ref.keys[0]).toMatchObject({ ambiguous: true, matchCount: 3 });
	});

	it("keeps the last resolution when one canonical key repeats", () => {
		const text = lines(30);
		const result = buildArtifacts(
			[
				ref("a.ts", text, { startLine: 2, endLine: 3 }),
				ref("a.ts", text, { startLine: 2, endLine: 3, quality: "fuzzy" }),
			],
			[],
		);

		expect(result.ok && result.artifacts[0].ref.keys).toHaveLength(1);
		expect(result.ok && result.artifacts[0].ref.keys[0].quality).toBe("fuzzy");
	});

	it("refuses more distinct keys into one file than the wire allows, never truncating", () => {
		const text = lines(REF_META_MAX_KEYS + 10);
		const refs = Array.from({ length: REF_META_MAX_KEYS + 1 }, (_, i) =>
			ref("a.ts", text, { startLine: i + 1, endLine: i + 1 }),
		);
		const result = buildArtifacts(refs, []);

		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain(`${REF_META_MAX_KEYS}`);
	});
});

describe("segment metadata partitioning the snapshot", () => {
	it("a full-mode snapshot declares no segments", () => {
		const result = buildArtifacts([ref("a.ts", lines(10), { startLine: 2, endLine: 4 })], []);

		expect(result.ok && result.artifacts[0].ref.segments).toBeUndefined();
	});

	it("snippet segments' line counts sum to exactly the snapshot's own line count", () => {
		const text = hugeFile();
		const result = buildArtifacts(
			[
				ref("big.ts", text, { startLine: 100, endLine: 104 }),
				ref("big.ts", text, { startLine: 900, endLine: 904 }),
			],
			[],
		);

		expect(result.ok).toBe(true);
		const artifact = result.ok ? result.artifacts[0] : undefined;
		const declared = (artifact?.ref.segments ?? []).reduce((sum, s) => sum + s.lineCount, 0);
		expect(declared).toBe(artifact?.content.split("\n").length);
	});

	it("each segment's declared slice reproduces the original file's lines", () => {
		const text = hugeFile();
		const result = buildArtifacts([ref("big.ts", text, { startLine: 900, endLine: 910 })], []);

		expect(result.ok).toBe(true);
		const artifact = result.ok ? result.artifacts[0] : undefined;
		const segment = artifact?.ref.segments?.[0];
		expect(segment?.startLine).toBe(897);
		const original = text
			.split("\n")
			.slice((segment?.startLine ?? 1) - 1, (segment?.startLine ?? 1) - 1 + (segment?.lineCount ?? 0));
		expect(artifact?.content.split("\n").slice(0, segment?.lineCount)).toEqual(original);
	});
});

describe("naming snapshots the way the phone will", () => {
	it("uses the name the file will actually land under, not the path it came from", () => {
		const result = buildArtifacts([ref("src/deep/app.ts", "x\n")], []);

		expect(result.ok && result.artifacts[0].filename).toBe("app.ts");
	});

	it("dedupes against the agent's own attachments, not just against other snapshots", () => {
		const result = buildArtifacts([ref("src/app.ts", "x\n")], ["app.ts"]);

		expect(result.ok && result.artifacts[0].filename).toBe("app-1.ts");
	});

	it("dedupes two source files that sanitize to one basename", () => {
		const result = buildArtifacts([ref("a/app.ts", "x\n"), ref("b/app.ts", "y\n")], []);

		expect(result.ok && result.artifacts.map((a) => a.filename)).toEqual(["app.ts", "app-1.ts"]);
	});

	it("accepts any attachment name - nothing is reserved anymore", () => {
		const result = buildArtifacts([ref("a.ts", "x\n")], ["switchboard-references.json"]);

		expect(result.ok).toBe(true);
	});
});

describe("staying inside the size caps", () => {
	it("snippets an oversized file that a ref narrows, keeping original line numbers", () => {
		const text = hugeFile();
		const result = buildArtifacts([ref("big.ts", text, { startLine: 900, endLine: 910 })], []);

		expect(result.ok).toBe(true);
		const artifact = result.ok ? result.artifacts[0] : undefined;
		expect(artifact?.ref.segments?.[0].startLine).toBe(897);
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

		expect(result.ok && result.artifacts[0].ref.segments).toHaveLength(1);
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

		expect(result.ok && result.artifacts[0].ref.segments).toHaveLength(2);
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
