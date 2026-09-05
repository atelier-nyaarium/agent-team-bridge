import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, linesMatching } from "./helpers/residue.js";

////////////////////////////////
//  Constants

const ROOT = path.resolve(import.meta.dirname, "..");
const FENCED = ["gateway", "federation-server", "shared"];

/** A direct read of the process clock, entropy, ids, or timers. */
const DIRECT = /\b(Date\.now|crypto\.randomUUID|randomUUID|crypto\.randomBytes|Math\.random)\b|\bnodeRandomBytes\b/;
const TIMERS = /(^|[^.\w])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/;

/**
 * Every entry names the one reason the ambient cannot reach it. Two groups, and nothing else:
 *
 * - Cryptographic material. A nonce, a token, or a key must be drawn from the platform CSPRNG,
 *   never from a record a caller supplies, so these four never take one.
 * - A reader outside a composed graph. `ownerLock` compares its heartbeat against another OS
 *   process's wall clock, `migration-fence` is a process-global with its own `useMigrationClock`
 *   seam that two graphs in one process would fight over, `reconnect` and `tmp-files` are also
 *   loaded by the MCP process, which composes no graph (reconnect takes an ambient when a graph
 *   supplies one; its fallback must NOT unref, since the host daemon's only live handle between
 *   connections is that timer).
 */
const ALLOWED: ReadonlyArray<{ file: string; why: string }> = [
	{ file: "shared/crypto.ts", why: "seals and key generation draw from the platform CSPRNG" },
	{ file: "shared/content-envelope.ts", why: "content nonces draw from the platform CSPRNG" },
	{ file: "shared/sealed-blob.ts", why: "blob chunk nonces draw from the platform CSPRNG" },
	{ file: "shared/session-tokens.ts", why: "session ids and bind tokens draw from the platform CSPRNG" },
	{ file: "shared/epoch.ts", why: "a mailbox epoch is a random tag, drawn outside any graph" },
	{ file: "shared/migration-fence.ts", why: "process-global fence with its own useMigrationClock seam" },
	{ file: "shared/reconnect.ts", why: "the MCP host daemon builds one with no graph to take an ambient from" },
	{ file: "shared/tmp-files.ts", why: "only the MCP process sweeps a tmp directory" },
	{ file: "federation-server/owner/ownerLock.ts", why: "heartbeat compared against another process's clock" },
];

////////////////////////////////
//  Tests

describe("ambient residue", () => {
	const allowed = new Set(ALLOWED.map((entry) => entry.file));
	const fenced = FENCED.flatMap((dir) => filesUnder(path.join(ROOT, dir)))
		.map((file) => ({ file, rel: path.relative(ROOT, file) }))
		.filter(({ rel }) => rel !== "shared/ambient.ts" && !allowed.has(rel));

	it("covers the fenced directories", () => {
		expect(fenced.length).toBeGreaterThan(150);
	});

	it("reads the clock, the entropy, and the ids only through the ambient", () => {
		const offenders = fenced
			.map(({ file, rel }) => ({ rel, lines: linesMatching(file, DIRECT) }))
			.filter(({ lines }) => lines.length > 0);
		expect(offenders).toEqual([]);
	});

	it("schedules only through the ambient", () => {
		const offenders = fenced
			.map(({ file, rel }) => ({ rel, lines: linesMatching(file, TIMERS) }))
			.filter(({ lines }) => lines.length > 0);
		expect(offenders).toEqual([]);
	});

	it("keeps every allowlist entry real and justified", () => {
		for (const entry of ALLOWED) {
			expect(entry.why.length).toBeGreaterThan(20);
			expect(filesUnder(ROOT).map((file) => path.relative(ROOT, file))).toContain(entry.file);
		}
	});
});
