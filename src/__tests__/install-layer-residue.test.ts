import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

const ROOT = path.join(import.meta.dirname, "..", "..");

/** The install hooks bun runs for this package, in the order it runs them. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Relative file paths named by a lifecycle script, which the image must hold before install runs. */
function scriptFiles(manifest: { scripts?: Record<string, string> }): string[] {
	const files = new Set<string>();
	for (const hook of LIFECYCLE) {
		for (const match of (manifest.scripts?.[hook] ?? "").matchAll(/(?:^|\s)((?:[\w-]+\/)+[\w.-]+\.\w+)(?=\s|$)/g)) {
			files.add(match[1]);
		}
	}
	return [...files];
}

/** Where a COPY lands relative to the working directory, for a file source or a directory source. */
type Landing = { source: string; destination: string };

/** The COPYs of the stage holding the first `RUN bun install`, with destinations relative to its WORKDIR. */
function copiedBeforeInstall(dockerfile: string): Landing[] {
	let landings: Landing[] = [];
	let workdir = "/";
	for (const line of dockerfile.split("\n")) {
		if (/^\s*RUN\s+bun\s+install\b/.test(line)) return landings;
		// A new stage starts with nothing; what an earlier stage copied is not in this one.
		if (/^\s*FROM\b/.test(line)) {
			landings = [];
			workdir = "/";
			continue;
		}
		const cd = line.match(/^\s*WORKDIR\s+(\S+)/);
		if (cd !== null) {
			workdir = path.posix.resolve(workdir, cd[1]);
			continue;
		}
		const copy = line.match(/^\s*COPY\s+(.+)$/);
		if (copy === null) continue;
		const args = copy[1].split(/\s+/).filter((arg) => arg !== "" && !arg.startsWith("--"));
		const target = args[args.length - 1] ?? "";
		const absolute = path.posix.resolve(workdir, target);
		const base = workdir === "/" ? "/" : `${workdir}/`;
		// A destination outside the working directory is not where a lifecycle script looks.
		const destination = absolute === workdir ? "" : absolute.startsWith(base) ? absolute.slice(base.length) : null;
		if (destination === null) continue;
		const intoDirectory = /\/$/.test(target) || target === "." || args.length > 2;
		for (const source of args.slice(0, -1)) {
			landings.push({
				source: source.replace(/^\.\//, "").replace(/\/$/, ""),
				destination: intoDirectory ? `${destination}/` : destination,
			});
		}
	}
	return landings;
}

/** Whether one COPY puts the file at the path the script names, as docker lays sources out. */
function lands(landing: Landing, file: string): boolean {
	const into = landing.destination.replace(/\/$/, "");
	// A directory source spills its contents into the destination, so the source name itself is gone.
	if (file.startsWith(`${landing.source}/`)) {
		return path.posix.join(into, file.slice(landing.source.length + 1)) === file;
	}
	if (file !== landing.source) return false;
	return landing.destination.endsWith("/") || landing.destination === ""
		? path.posix.join(into, path.posix.basename(file)) === file
		: landing.destination === file;
}

/** Lifecycle files no COPY before install puts where the script names them. */
function uncopied(dockerfile: string, files: string[]): string[] {
	const landings = copiedBeforeInstall(dockerfile);
	return files.filter((file) => !landings.some((landing) => lands(landing, file)));
}

////////////////////////////////
//  Tests

describe("what the image copies before it installs", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
	const files = scriptFiles(manifest);
	const hook = ["scripts/link-lexicon.mjs"];

	it("found lifecycle files to check", () => {
		expect(files).toContain(hook[0]);
	});

	it("fires on a planted Dockerfile that installs before copying the hook", () => {
		expect(uncopied("COPY package.json bun.lock ./\nRUN bun install\nCOPY scripts/ scripts/\n", hook)).toEqual(
			hook,
		);
		expect(uncopied("COPY scripts/ scripts/\nRUN bun install\n", hook)).toEqual([]);
		expect(uncopied("WORKDIR /app\nCOPY scripts/link-lexicon.mjs scripts/\nRUN bun install\n", hook)).toEqual([]);
		expect(
			uncopied("COPY --chown=bun scripts/link-lexicon.mjs scripts/link-lexicon.mjs\nRUN bun install\n", hook),
		).toEqual([]);
	});

	it("fires when the copy lands the file somewhere the script does not look", () => {
		expect(uncopied("WORKDIR /app\nCOPY scripts /app\nRUN bun install\n", hook)).toEqual(hook);
		expect(uncopied("WORKDIR /app\nCOPY scripts /app/scripts\nRUN bun install\n", hook)).toEqual([]);
		expect(uncopied("WORKDIR /app\nCOPY scripts/link-lexicon.mjs /opt/\nRUN bun install\n", hook)).toEqual(hook);
		expect(uncopied("WORKDIR /app\nCOPY scripts/link-lexicon.mjs hook.mjs\nRUN bun install\n", hook)).toEqual(hook);
	});

	it("fires when an earlier stage copied the file and the installing stage did not", () => {
		const staged = "FROM a AS one\nCOPY scripts/ scripts/\nFROM b\nCOPY package.json ./\nRUN bun install\n";
		expect(uncopied(staged, hook)).toEqual(hook);
	});

	it("copies every file a lifecycle script runs before bun install", () => {
		expect(dockerfile).toMatch(/^\s*RUN\s+bun\s+install\b/m);
		expect(uncopied(dockerfile, files)).toEqual([]);
	});
});
