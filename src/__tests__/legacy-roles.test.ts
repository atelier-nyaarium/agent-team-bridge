import { describe, expect, it } from "vitest";
import { stampLegacyRoles, stampLegacyRolesDeep } from "../gateway/legacyRoles.js";
import type { ChannelFile } from "../shared/types.js";

////////////////////////////////
//  Functions & Helpers

function file(filename: string, role?: ChannelFile["role"]): ChannelFile {
	return { filename, mime: "text/plain", size: 1, descriptiveKey: filename, ...(role ? { role } : {}) };
}

////////////////////////////////
//  Tests

describe("stampLegacyRoles", () => {
	it("stamps the pre-role convention and drops the manifest entry outright", () => {
		const stamped = stampLegacyRoles([
			file("shot.png"),
			file("notes.md"),
			file("switchboard-references.json"),
			file("cart.ts"),
		]);

		expect(stamped.map((f) => f.filename)).toEqual(["shot.png", "notes.md", "cart.ts"]);
		expect(stamped.map((f) => f.role)).toEqual(["attachment", "attachment", "ref-snapshot"]);
	});

	it("stamps a list with no manifest as all ordinary attachments", () => {
		const stamped = stampLegacyRoles([file("a.png"), file("b.log")]);

		expect(stamped.map((f) => f.role)).toEqual(["attachment", "attachment"]);
	});

	it("passes a post-role list through untouched, which is what makes re-stamping a no-op", () => {
		const files = [file("shot.png", "attachment"), file("cart.ts", "ref-snapshot")];

		expect(stampLegacyRoles(files)).toBe(files);
	});

	it("leaves a partially-roled list alone rather than guessing at the rest", () => {
		const files = [file("a.png"), file("mock.html", "design-card")];

		expect(stampLegacyRoles(files)).toBe(files);
	});
});

describe("stampLegacyRolesDeep", () => {
	it("stamps mailbox-shaped state in place, entries and all", () => {
		const boxes = {
			"device-1": {
				epoch: 7,
				entries: [
					{
						kind: "message",
						session_id: "s1",
						files: [file("shot.png"), file("switchboard-references.json")],
					},
					{ kind: "message", session_id: "s2" },
				],
			},
		};

		stampLegacyRolesDeep(boxes);

		expect(boxes["device-1"].entries[0].files?.map((f) => f.filename)).toEqual(["shot.png"]);
		expect(boxes["device-1"].entries[0].files?.map((f) => f.role)).toEqual(["attachment"]);
	});

	it("stamps a stored job result's files", () => {
		const jobs = [{ id: "j1", storedResult: { session_id: "s1", files: [file("notes.md")] } }];

		stampLegacyRolesDeep(jobs);

		expect(jobs[0].storedResult.files.map((f) => f.role)).toEqual(["attachment"]);
	});

	it("walks primitives, nulls, and non-file arrays without touching them", () => {
		const value = { a: null, b: [1, "x"], c: { files: ["not-a-file-object"] } };

		stampLegacyRolesDeep(value);

		expect(value.c.files).toEqual(["not-a-file-object"]);
	});
});
