import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const expected = path.resolve(import.meta.dirname, "../tests/fixtures/wire/ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wire-fixtures-check-"));
const result = spawnSync("bun", ["scripts/gen-wire-fixtures.ts"], {
	cwd: path.resolve(import.meta.dirname, ".."),
	env: { ...process.env, WIRE_FIXTURE_DIR: temp },
	encoding: "utf8",
});
if (result.status !== 0) process.exit(result.status ?? 1);
const files = (dir: string): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? files(full).map((file) => path.join(entry.name, file)) : [entry.name];
	});
const all = [...new Set([...files(expected), ...files(temp)])].sort();
let failed = false;
for (const file of all) {
	const left = fs.existsSync(path.join(expected, file)) ? fs.readFileSync(path.join(expected, file)) : null;
	const right = fs.existsSync(path.join(temp, file)) ? fs.readFileSync(path.join(temp, file)) : null;
	if (!left || !right || !left.equals(right)) {
		console.error(file);
		failed = true;
	}
}
fs.rmSync(temp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
