import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Constants

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY_DIR = path.join(REPO_ROOT, "src", "gateway");

/** The one sanctioned mailbox writer: consolePushOps.deliverToOwner. */
const OWNER_FILE = path.join(GATEWAY_DIR, "consolePushOps.ts");

/** A mailbox append outside the funnel. `.append(` is unambiguous under src/gateway: nothing
 * else there exposes an append method, and the historical defect was exactly a fifth producer
 * appending locally without the convergence relay - three separate fixes in one day before the
 * funnel. */
const APPEND = /\.append\s*\(/;

////////////////////////////////
//  Functions & Helpers

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

/** Source with comments removed, so the funnel may be explained in prose anywhere. */
function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

////////////////////////////////
//  Tests

describe("console mailbox delivery residue", () => {
	const files = walk(GATEWAY_DIR);

	it("the funnel owner exists and contains the sanctioned append (positive control)", () => {
		expect(files).toContain(OWNER_FILE);
		expect(APPEND.test(code(OWNER_FILE))).toBe(true);
	});

	it("scans the historical offender files, so a rename cannot hollow the guard out", () => {
		for (const name of ["consolePeer.ts", "consoleDevices.ts", "routes.ts"]) {
			expect(files.some((f) => f.endsWith(name))).toBe(true);
		}
	});

	it("no file under src/gateway outside the funnel appends to a mailbox", () => {
		const offenders = files.filter((f) => f !== OWNER_FILE && APPEND.test(code(f)));
		expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
	});
});
