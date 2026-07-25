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
const CHAT_REPOSITORY = path.join(
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
	"ChatRepository.kt",
);

/** The body of a top-level `fun <name>` in the repository class, by brace matching. */
function functionBody(source: string, name: string): string {
	const start = source.indexOf(`fun ${name}(`);
	if (start === -1) throw new Error(`ChatRepository.kt no longer declares ${name}`);

	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
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
		const body = functionBody(fs.readFileSync(CHAT_REPOSITORY, "utf8"), "clearDraft");

		expect(body).not.toContain("scheduleAttachmentDelete");
	});

	it("still deletes a pick discarded one at a time, which races nothing", () => {
		const body = functionBody(fs.readFileSync(CHAT_REPOSITORY, "utf8"), "removeDraftFile");

		expect(body).toContain("scheduleAttachmentDelete");
	});
});
