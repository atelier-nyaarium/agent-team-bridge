import { describe, expect, it } from "vitest";
import { dropReferenceArtifacts } from "../mcp/channel/channelFiles.js";
import {
	ChannelFileSchema,
	ChannelFilesSchema,
	REF_META_MAX_KEYS,
	REF_META_MAX_SEGMENTS,
} from "../shared/channel-file.js";

const base = {
	filename: "a.txt",
	mime: "text/plain",
	size: 1,
	descriptiveKey: "a.txt",
	role: "attachment" as const,
};

describe("ChannelFile wire rules", () => {
	it("requires one of the three declared roles", () => {
		expect(ChannelFileSchema.safeParse(base).success).toBe(true);
		for (const role of ["ref-snapshot", "design-card"] as const) {
			expect(ChannelFileSchema.safeParse({ ...base, role }).success).toBe(true);
		}
		expect(ChannelFileSchema.safeParse({ ...base, role: undefined }).success).toBe(false);
		expect(ChannelFileSchema.safeParse({ ...base, role: "future" }).success).toBe(false);
	});

	it("bounds metadata, references, cards, timestamps, and blob ids", () => {
		expect(ChannelFileSchema.safeParse({ ...base, filename: "", size: -1 }).success).toBe(false);
		expect(ChannelFileSchema.safeParse({ ...base, filename: "a".repeat(256) }).success).toBe(false);
		expect(ChannelFileSchema.safeParse({ ...base, modifiedAt: 8_640_000_000_000_000 }).success).toBe(true);
		expect(ChannelFileSchema.safeParse({ ...base, modifiedAt: 8_640_000_000_000_001 }).success).toBe(false);
		expect(ChannelFileSchema.safeParse({ ...base, blobId: `sha256-${"a".repeat(64)}` }).success).toBe(true);
		expect(ChannelFileSchema.safeParse({ ...base, blobId: "sha256-bad" }).success).toBe(false);
		expect(ChannelFileSchema.safeParse({ ...base, ref: { refPath: "x", keys: [] } }).success).toBe(true);
		expect(
			ChannelFileSchema.safeParse({
				...base,
				ref: {
					refPath: "x",
					segments: Array.from({ length: REF_META_MAX_SEGMENTS + 1 }, () => ({ startLine: 1, lineCount: 1 })),
					keys: Array.from({ length: REF_META_MAX_KEYS + 1 }, (_, i) => ({
						key: String(i),
						startLine: 1,
						endLine: 1,
						quality: "exact",
					})),
				},
			}).success,
		).toBe(false);
		expect(
			ChannelFileSchema.safeParse({ ...base, role: "design-card", cardWidth: 8192, cardHeight: 1 }).success,
		).toBe(true);
		expect(ChannelFileSchema.safeParse({ ...base, role: "design-card", cardWidth: 8193 }).success).toBe(false);
	});

	it("caps a message at ten files", () => {
		expect(ChannelFilesSchema.safeParse(Array.from({ length: 10 }, () => base)).success).toBe(true);
		expect(ChannelFilesSchema.safeParse(Array.from({ length: 11 }, () => base)).success).toBe(false);
	});

	it("drops snapshots by role, independent of filename", () => {
		const files = [base, { ...base, filename: "ordinary.txt" }, { ...base, role: "ref-snapshot" as const }];
		expect(dropReferenceArtifacts(files).map((file) => file.filename)).toEqual(["a.txt", "ordinary.txt"]);
	});
});
