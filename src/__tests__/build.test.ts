import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkDerivedSites,
	dirtyTrackedFiles,
	nextVersion,
	readVersion,
	setVersion,
	versionTargets,
} from "../../scripts/build.js";

////////////////////////////////
//  Functions & Helpers

const ROOT = path.join(import.meta.dirname, "..", "..");

////////////////////////////////
//  Tests

describe("computing the next version", () => {
	it("bumps a patch", () => {
		expect(nextVersion("7.13.4", "patch")).toBe("7.13.5");
	});

	it("bumps a minor and resets the patch", () => {
		expect(nextVersion("7.13.4", "minor")).toBe("7.14.0");
	});

	it("bumps a major and resets both", () => {
		expect(nextVersion("7.13.4", "major")).toBe("8.0.0");
	});

	it("refuses a version this arithmetic cannot reason about, rather than mangling it", () => {
		// A prerelease or build-metadata suffix has rules of its own. Set that by hand.
		expect(() => nextVersion("7.13.0-rc.1", "patch")).toThrow(/not a plain/);
	});
});

describe("rewriting a version field", () => {
	const FILE = ['{\n\t"name": "switchboard",', '\t"version": "1.2.3",', '\t"type": "module"\n}'].join("\n");

	it("reads the version back out", () => {
		expect(readVersion(FILE)).toBe("1.2.3");
	});

	it("changes the version and nothing else, formatting included", () => {
		expect(setVersion(FILE, "1.3.0")).toBe(FILE.replace('"1.2.3"', '"1.3.0"'));
	});

	it("refuses a file with two version fields rather than guessing which one is the project's", () => {
		const ambiguous = '{\n\t"version": "1.2.3",\n\t"dep": { "version": "0.1.0" }\n}';

		expect(() => setVersion(ambiguous, "1.3.0")).toThrow(/exactly one/);
	});

	it("refuses a file with no version field", () => {
		expect(() => setVersion('{\n\t"name": "x"\n}', "1.3.0")).toThrow(/exactly one/);
	});
});

describe("the set of files a bump writes", () => {
	// The whole value of one bump command is that it reaches everything. A target list that silently
	// stops matching the repo is the exact failure it exists to prevent, so it is asserted against
	// the real tree rather than a fixture.
	const targets = versionTargets(ROOT);

	it("bumps package.json first, since every other target is set from it", () => {
		expect(targets[0]).toBe("package.json");
	});

	it("covers the marketplace manifest, which decides whether an update ships at all", () => {
		expect(targets).toContain(path.join(".claude-plugin", "plugin.json"));
	});

	it("covers every baked-in console plugin manifest", () => {
		const dir = path.join(ROOT, "android", "app", "src", "main", "assets", "plugins");
		const shipped = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) =>
				path.join("android", "app", "src", "main", "assets", "plugins", entry.name, "manifest.json"),
			);

		expect(targets).toEqual(expect.arrayContaining(shipped));
	});

	it("names only files that exist and each carry exactly one version field", () => {
		for (const target of targets) {
			const text = fs.readFileSync(path.join(ROOT, target), "utf8");
			expect(() => readVersion(text)).not.toThrow();
		}
	});

	it("still finds the APK and MCP versions derived from package.json rather than hard-coded", () => {
		// These two are the ones a bump does NOT write. If either ever stores a literal instead, the
		// bump goes out half-applied: the marketplace updates while the running server reports the old
		// number, which reads as a failed update rather than a missed edit.
		expect(() => checkDerivedSites(ROOT)).not.toThrow();
	});

	it("refuses to bump at all once a derived site stops deriving", () => {
		const fake = fs.mkdtempSync(path.join(os.tmpdir(), "bump-"));
		fs.mkdirSync(path.join(fake, "android", "app"), { recursive: true });
		fs.mkdirSync(path.join(fake, "src", "mcp"), { recursive: true });
		fs.writeFileSync(path.join(fake, "android", "app", "build.gradle.kts"), 'versionName = "7.13.0"\n');
		fs.writeFileSync(path.join(fake, "src", "mcp", "index.ts"), 'version: "7.13.0"\n');
		try {
			expect(() => checkDerivedSites(fake)).toThrow(/no longer derives/);
		} finally {
			fs.rmSync(fake, { recursive: true, force: true });
		}
	});

	it("agrees with itself: every target already carries the same version package.json does", () => {
		// A bump sets them all together, so a mismatch here means something was edited by hand and the
		// next bump would have quietly papered over it.
		const version = readVersion(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

		for (const target of targets) {
			expect([target, readVersion(fs.readFileSync(path.join(ROOT, target), "utf8"))]).toEqual([target, version]);
		}
	});
});

describe("the clean-tree gate", () => {
	// Real `git status --porcelain=v2 --branch` shapes: header lines, then one record per path.
	const headers = "# branch.oid abc123\n# branch.head main\n";

	it("passes a clean tree", () => {
		expect(dirtyTrackedFiles(headers)).toEqual([]);
	});

	it("catches an ordinary modification", () => {
		expect(dirtyTrackedFiles(`${headers}1 .M N... 100644 100644 100644 abc def package.json`)).toEqual([
			"package.json",
		]);
	});

	it("lets untracked and ignored files through, so a scratch file cannot block a release", () => {
		expect(dirtyTrackedFiles(`${headers}? scratch.txt\n! node_modules/\n`)).toEqual([]);
	});

	it("keeps spaces in a path rather than truncating at the first one", () => {
		expect(dirtyTrackedFiles(`${headers}1 .M N... 100644 100644 100644 abc def my notes.md`)).toEqual([
			"my notes.md",
		]);
	});

	it("reports the new path of a rename, not the original it trails", () => {
		expect(dirtyTrackedFiles(`${headers}2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts`)).toEqual([
			"new.ts",
		]);
	});

	it("catches an unmerged path, which has its own field count", () => {
		expect(dirtyTrackedFiles(`${headers}u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts`)).toEqual([
			"conflict.ts",
		]);
	});
});
