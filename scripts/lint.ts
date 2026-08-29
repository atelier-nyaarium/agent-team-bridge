import { spawnSync } from "node:child_process";

////////////////////////////////
//  Interfaces & Types

interface Half {
	name: string;
	args: string[];
}

////////////////////////////////
//  Constants

const HALVES: Half[] = [
	{ name: "biome", args: ["biome", "ci", "."] },
	{ name: "tsc", args: ["tsc", "--noEmit"] },
];

////////////////////////////////
//  Main

const results = HALVES.map((half) => {
	console.log(`\n[${half.name}]`);
	const result = spawnSync("bunx", half.args, { stdio: "inherit" });
	return { name: half.name, ok: result.status === 0 };
});

console.log("");
for (const result of results) console.log(`${result.name}: ${result.ok ? "ok" : "FAILED"}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
