////////////////////////////////
//  Constants

/**
 * The lowest bun the gateway may run on.
 *
 * Below it, bun's substitute for the `ws` package ignores `createConnection`, so the Router
 * certificate pin in `gateway/router/pinnedSocket.ts` is never handed the socket and every dial
 * reports `pending`: nothing was checked, and the gateway is talking to whatever answered. The
 * Dockerized gateway was held above this by the base image (`oven/bun:1`, pulled fresh); a native
 * gateway runs whatever bun the host has, which is why the check lives in the process now.
 *
 * OBSERVED, not a bun contract: this is the version the outage was fixed against and the one
 * `scripts/check-pinning-runtime.ts` proves on every CI run. Raise it only against that script's
 * verdict on the new runtime, never from a changelog.
 *
 * The gateway and MCP entries hold this floor. MCP spawns the lexicon daemon on the bun it runs on.
 * The host daemon pins nothing because it dials the gateway over plain ws://localhost.
 */
export const BUN_FLOOR = "1.4.0";

////////////////////////////////
//  Interfaces & Types

export type BunFloorVerdict = { ok: true; runtime: string } | { ok: false; runtime: string; reason: string };

////////////////////////////////
//  Functions & Helpers

/**
 * Numeric dotted compare, negative when `a` is older. A missing segment reads as 0 and a segment
 * that is not a number reads as older than anything, so a garbage version cannot pass by accident.
 * A pre-release tag (`1.4.0-canary.12`) is ignored: the substitution defect is a property of the
 * line, not of the build.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string): number[] =>
		v
			.split("-")[0]
			.split(".")
			.map((s) => (/^\d+$/.test(s) ? Number(s) : -1));
	const pa = parse(a);
	const pb = parse(b);
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * What a runtime answers. `bunVersion` undefined is node, where the real `ws` package is in play
 * and a peer certificate is always readable, so there is no floor to hold. Pure, so the refusal is
 * unit-tested under node, where `Bun` does not exist.
 */
export function bunFloorVerdict(bunVersion: string | undefined): BunFloorVerdict {
	if (bunVersion === undefined) return { ok: true, runtime: `node ${process.version}` };
	const runtime = `bun ${bunVersion}`;
	if (compareVersions(bunVersion, BUN_FLOOR) >= 0) return { ok: true, runtime };
	return {
		ok: false,
		runtime,
		reason: `bun ${BUN_FLOOR}+ is required: below it the Router certificate pin is never consulted, so the gateway cannot tell its Router from an impostor`,
	};
}

/**
 * Refuse to serve on a runtime that cannot pin the Router. Runs before anything is constructed, and
 * exits rather than throws: the message is the whole point, and a supervisor's restart loop would
 * otherwise bury it under the next attempt.
 */
export function assertBunFloor(): void {
	const verdict = bunFloorVerdict((globalThis as { Bun?: { version: string } }).Bun?.version);
	if (verdict.ok) return;
	console.error(`[gateway] refusing to start on ${verdict.runtime}: ${verdict.reason}`);
	process.exit(1);
}
