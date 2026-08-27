import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentReady, isAgentWorking } from "../shared/agent-screen.js";

/**
 * Real captured panes, Linux and Windows, read by BOTH runtimes.
 *
 * Every frame here came off a live tmux server at the daemon's own geometry (TMUX_COLS x TMUX_ROWS),
 * through `capture-pane -e -J -p`, from the same Claude Code build on both platforms - so a difference
 * between two vectors is a rendering difference and never a version drift.
 *
 * Three distinct causes made the Windows frames unreadable, and the corpus keeps them separable rather
 * than lumping them into "Windows is different":
 *
 *   (a) the composer glyph is U+003E, not U+276F
 *   (b) the TOP rule arrives welded to the composer row - always, so the glyph is never at column 0
 *   (c) the BOTTOM rule arrives welded to the footer - only after a resize, and `peekPane` resizes on
 *       every peek, so the wake path induces this one deliberately at the moment it judges the wake
 *
 * `win-working-unresized` is what makes (c) a cause in its own right: same platform, same session, no
 * resize, and `isAgentWorking` was already correct there. Without it the corpus could not tell (c)
 * apart from "Windows breaks the footer too". `lin-working-resized` is the other half of that control:
 * the identical resize cycle on Linux joins nothing.
 *
 * The Kotlin twin reads this same file (AgentScreenVectorsTest.kt). A reader that passes here and
 * fails there is a divergence between the two implementations, which is the failure this corpus is
 * for - the markers are hand-mirrored across languages and nothing else holds them together.
 */
interface Vector {
	name: string;
	platform: "linux" | "windows";
	shape: string;
	screen: string;
	expectReady: boolean;
	expectWorking: boolean;
}

const vectorsPath = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "agent-screen", "vectors.json");
const { vectors } = JSON.parse(fs.readFileSync(vectorsPath, "utf8")) as { vectors: Vector[] };

describe("agent-screen: real captured panes, both platforms", () => {
	it("has a corpus at all, covering both platforms", () => {
		// Vacuity guard: an empty or single-platform corpus must fail rather than pass silently.
		expect(vectors.length).toBeGreaterThanOrEqual(6);
		expect(vectors.some((v) => v.platform === "linux")).toBe(true);
		expect(vectors.some((v) => v.platform === "windows")).toBe(true);
		// The frames are raw captures, so every one carries the ESC bytes -e produced. A corpus that
		// lost them during a rewrite would still parse and would quietly stop testing stripAnsi.
		for (const v of vectors) expect(v.screen, v.name).toContain("[");
	});

	it.each(vectors)("$name ($shape)", (v) => {
		expect(isAgentReady(v.screen), `${v.name}: isAgentReady`).toBe(v.expectReady);
		expect(isAgentWorking(v.screen), `${v.name}: isAgentWorking`).toBe(v.expectWorking);
	});

	it("keeps the three Windows causes separable", () => {
		// Named rather than implied: if someone prunes the corpus to "one Windows frame", this is what
		// tells them which distinctions they are about to lose.
		const byName = new Map(vectors.map((v) => [v.name, v]));
		const unresized = byName.get("win-working-unresized");
		const joined = byName.get("win-working-joined");
		expect(unresized, "the (c)-isolating frame").toBeDefined();
		expect(joined, "the all-three frame").toBeDefined();
		// Both must read working, and they reach it by different routes: one footer is on its own line,
		// the other is welded to its rule.
		expect(isAgentWorking(unresized!.screen)).toBe(true);
		expect(isAgentWorking(joined!.screen)).toBe(true);
	});
});
