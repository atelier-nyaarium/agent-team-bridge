import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * A source-residue guard, deliberately in the suite that gates a PR.
 *
 * The Android unit tests only run on push to main, so a Kotlin-side test cannot stop this
 * regression from landing. `clearDraft` needs a live repository to exercise behaviourally, which is
 * out of reach here, so this pins the one line whose presence caused the bug instead.
 */
const ANDROID_SRC = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

/** The declaration, as a member or as an extension on the repository. */
function declaration(name: string): RegExp {
	return new RegExp(String.raw`fun\s+(?:ChatRepository\.)?${name}\s*\(`);
}

/**
 * The body of a draft writer, found anywhere under the android sources.
 *
 * Searched rather than read from a named file: these functions move between files as the sources
 * are split, and a path pinned here fails as a missing declaration, which reads identically to the
 * declaration being deleted. Throws when there is no single match, so a rename cannot pass silently.
 */
function functionBody(name: string): string {
	const decl = declaration(name);
	const hits = fs
		.readdirSync(ANDROID_SRC, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".kt"))
		.map((f) => fs.readFileSync(path.join(ANDROID_SRC, f), "utf8"))
		.filter((source) => decl.test(source));

	if (hits.length !== 1) throw new Error(`expected exactly one declaration of ${name}, found ${hits.length}`);

	const open = hits[0].indexOf("{", hits[0].search(decl));
	let depth = 0;
	for (let i = open; i < hits[0].length; i++) {
		if (hits[0][i] === "{") depth++;
		else if (hits[0][i] === "}" && --depth === 0) return hits[0].slice(open, i + 1);
	}
	throw new Error(`could not find the end of ${name}`);
}

////////////////////////////////
//  Tests

describe("clearing a draft that was just handed to a send", () => {
	// Every clearDraft call site fires immediately after handing the draft's files to a send that
	// reads them on another coroutine. Deleting there is a race the send loses: it opened a file that
	// existed a millisecond earlier, got ENOENT, and dropped the attachment with no error anywhere.
	// That silently lost every attachment sent from the composer.
	it("does not delete the picked copies the send is still reading", () => {
		expect(functionBody("clearDraft")).not.toContain("scheduleAttachmentDelete");
	});

	it("still deletes a pick discarded one at a time, which races nothing", () => {
		expect(functionBody("removeDraftFile")).toContain("scheduleAttachmentDelete");
	});
});
