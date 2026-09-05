import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity as load } from "../gateway/federation/identity.js";
import { processAmbient } from "../shared/ambient.js";
import { fingerprint } from "../shared/crypto.js";

const loadOrCreateIdentity = (dir: string) => load(dir, processAmbient().newId);

const dirs: string[] = [];
function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "fed-id-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("federation identity", () => {
	it("mints and persists an identity on first boot", () => {
		const dir = tmpDir();
		const id = loadOrCreateIdentity(dir);
		expect(Buffer.from(id.sign.pub, "base64")).toHaveLength(32);
		const file = path.join(dir, "federation-identity.json");
		expect(fs.existsSync(file)).toBe(true);
		// Private keys persist; perms are owner-only.
		expect(fs.statSync(file).mode & 0o077).toBe(0);
	});

	it("returns the SAME identity on a second boot (stable across restarts)", () => {
		const dir = tmpDir();
		const a = loadOrCreateIdentity(dir);
		const b = loadOrCreateIdentity(dir);
		expect(b).toEqual(a);
	});

	it("fails closed (throws) on a present-but-malformed file instead of overwriting the admitted key", () => {
		const dir = tmpDir();
		const file = path.join(dir, "federation-identity.json");
		fs.writeFileSync(file, "{ not valid");
		expect(() => loadOrCreateIdentity(dir)).toThrow(/refusing to overwrite/);
		// The orphan file is left untouched for a human to inspect/restore, never replaced.
		expect(fs.readFileSync(file, "utf8")).toBe("{ not valid");
	});

	it("fails closed on a file that parses but is not an identity", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "federation-identity.json"), JSON.stringify({ sign: { pub: "x" } }));
		expect(() => loadOrCreateIdentity(dir)).toThrow(/refusing to overwrite/);
	});

	it("lets concurrent first boots observe the same on-disk identity", async () => {
		const dir = tmpDir();
		const identityFile = path.join(dir, "federation-identity.json");
		const script = `import fs from "node:fs"; import { fingerprint } from ${JSON.stringify(path.join(process.cwd(), "src/shared/crypto.ts"))}; const id = JSON.parse(fs.readFileSync(${JSON.stringify(identityFile)}, "utf8")); process.stdout.write(fingerprint(id.sign.pub));`;
		const run = () =>
			new Promise<string>((resolve, reject) => {
				const child = spawn("bun", [
					"-e",
					`import { loadOrCreateIdentity } from ${JSON.stringify(path.join(process.cwd(), "src/gateway/federation/identity.ts"))}; loadOrCreateIdentity(${JSON.stringify(dir)}, () => String(process.pid)); ${script}`,
				]);
				let output = "";
				child.stdout.on("data", (chunk) => (output += chunk));
				child.on("error", reject);
				child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("child failed"))));
			});
		const outputs = await Promise.all([run(), run()]);
		const disk = JSON.parse(fs.readFileSync(identityFile, "utf8"));
		const expected = fingerprint(disk.sign.pub);
		expect(outputs.every((output) => output.endsWith(expected))).toBe(true);
	});
});
