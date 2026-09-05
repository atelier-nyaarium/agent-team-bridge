import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, linesMatching } from "./helpers/residue.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FENCED = ["gateway", "federation-server", "shared"];

const DIRECT =
	/\b(Date\.now|performance\.now|crypto\.randomUUID|randomUUID|crypto\.randomBytes|Math\.random)\b|(^|[^.\w"'])randomBytes\b|\bnew Date\(\s*\)|\bnodeRandomBytes\b/;
const TIMERS = /(^|[^.\w])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/;

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

describe("ambient residue", () => {
	const allowed = new Set(ALLOWED.map((entry) => entry.file));
	const fenced = FENCED.flatMap((dir) => filesUnder(path.join(ROOT, dir)))
		.map((file) => ({ file, rel: path.relative(ROOT, file) }))
		.filter(({ rel }) => rel !== "shared/ambient.ts" && !allowed.has(rel));

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
			const abs = path.join(ROOT, entry.file);
			expect(filesUnder(ROOT).map((file) => path.relative(ROOT, file))).toContain(entry.file);
			expect(linesMatching(abs, DIRECT).length + linesMatching(abs, TIMERS).length).toBeGreaterThan(0);
		}
	});
});
