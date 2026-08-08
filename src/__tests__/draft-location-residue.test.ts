import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * A source-residue guard for the one field that must never reach the wire.
 *
 * Where a picked file came from is shown in the composer as a pre-send check. A device path names a
 * user and a folder layout, and these cross a gateway to another machine, so the guarantee is
 * structural: the value lives on `Draft`, and nothing file-shaped has anywhere to put it. That is
 * only true while no file type grows such a field, which is what this pins.
 *
 * Deliberately in the TS suite: the Android tests run on push to main, so a Kotlin-side assertion
 * could not stop the regression from landing in a PR.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

const ANDROID_SRC = path.join(
	REPO_ROOT,
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

/** Every type a file's fields travel through on the way out, in order. */
const FILE_SHAPED_SOURCES = [
	path.join(REPO_ROOT, "src", "shared", "channel-file.ts"),
	path.join(ANDROID_SRC, "proto", "Protocol.kt"),
	path.join(ANDROID_SRC, "OutgoingFiles.kt"),
];

/** A declaration of a field whose name suggests a filesystem origin. Matches a Kotlin `val x:` or a
 * zod `x:` property, not a mention in prose. */
const LOCATION_FIELD = /^\s*(?:val\s+|var\s+)?(sourceLocation|location|sourcePath|originPath)\s*:/m;

function read(file: string): string {
	return fs.readFileSync(file, "utf8");
}

/**
 * A Kotlin data class's constructor body, found anywhere under the android sources.
 *
 * Searched rather than read from a named file: these types move between files as the sources are
 * split, and a path pinned here fails as a missing declaration, which reads identically to the
 * declaration being deleted. Throws when there is no single match, so a rename cannot pass silently.
 */
function dataClassBody(name: string): string {
	const needle = `data class ${name}(`;
	const hits = fs
		.readdirSync(ANDROID_SRC, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".kt"))
		.map((f) => read(path.join(ANDROID_SRC, f)))
		.filter((source) => source.includes(needle));

	if (hits.length !== 1) throw new Error(`expected exactly one declaration of ${name}, found ${hits.length}`);

	const start = hits[0].indexOf(needle);
	return hits[0].slice(start, hits[0].indexOf("\n)", start));
}

////////////////////////////////
//  Tests

describe("a picked file's origin never reaches the wire", () => {
	it.each(FILE_SHAPED_SOURCES)("%s declares no origin field", (file) => {
		const source = read(file);

		expect(LOCATION_FIELD.test(source)).toBe(false);
	});

	it("MessageFile declares no origin field, so the conversion has nowhere to put one", () => {
		// The device's own row type. It is what a Draft holds and what storeOutgoing produces, so a
		// field here would flow to the wire through storeOutgoing's successor without anyone noticing.
		expect(LOCATION_FIELD.test(dataClassBody("MessageFile"))).toBe(false);
	});

	it("Draft is where it actually lives, so the guard above is proving something", () => {
		// Without this the suite would still pass if the feature were deleted outright, which would
		// make every assertion here vacuous.
		expect(dataClassBody("Draft")).toContain("locations");
	});
});
