import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function filesUnder(dir: string, suffix = ".ts"): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) files.push(...filesUnder(full, suffix));
		else if (full.endsWith(suffix)) files.push(full);
	}
	return files;
}

export function linesMatching(file: string, pattern: RegExp): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => pattern.test(line));
}
