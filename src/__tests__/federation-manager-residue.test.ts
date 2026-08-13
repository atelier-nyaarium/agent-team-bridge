import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Functions & Helpers

/**
 * A source-residue guard over who may reach the owner's signing keys.
 *
 * `FederationManager` signs and merges owner facts. The merge-iff-accepted invariant (an owner action
 * cannot submit without the matching local merge, or a revoked member stays visible on the board)
 * holds only because every caller goes through one of the files below. `ChatRepository.federation` is
 * declared `internal`, not `private`, so nothing in the compiler stops another file in the module from
 * merging an admission evie rejected, or adding a trusted owner with no ceremony - this guard is what
 * actually enforces the boundary.
 *
 * Deliberately in the TS suite: the Android tests only run on push to main, so a Kotlin-side
 * assertion could not block a bad PR that widens this reachability again.
 */
const ANDROID_SRC = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

/** The manager itself, plus the six collaborators the repository hands it to. */
const ALLOWED = [
	"ChatRepository.kt",
	"DeviceApprovalOps.kt",
	"DomainAdminOps.kt",
	"EnrollCeremonyOps.kt",
	"GatewayEnrollment.kt",
	"OwnerFacts.kt",
	"TrustOps.kt",
];

/** Where the type is declared, so its own file cannot count as a caller. */
const DECLARING_FILE = "FederationManager.kt";

/** The manager as a receiver (`federation.sign(...)`) or as a property read (`repo.federation`). */
const REACHES_MANAGER = /(^|[^\w.])federation\s*\.|\.federation\b/;

/** Kotlin sources with comments and string literals stripped, so prose naming the field cannot trip
 * the match and a string cannot hide one. */
function code(file: string): string {
	return fs
		.readFileSync(path.join(ANDROID_SRC, file), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function kotlinSources(): string[] {
	return fs
		.readdirSync(ANDROID_SRC, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".kt") && path.basename(f) !== DECLARING_FILE);
}

////////////////////////////////
//  Tests

describe("only the repository and its federation collaborators reach FederationManager", () => {
	it("no other source touches it", () => {
		const callers = kotlinSources()
			.filter((f) => REACHES_MANAGER.test(code(f)))
			.map((f) => path.basename(f))
			.sort();

		expect(callers).toEqual([...ALLOWED].sort());
	});

	it.each(ALLOWED)("%s really does reach it, so the guard above is proving something", (file) => {
		// Without this the assertion would still pass if the surface were renamed out from under it.
		expect(REACHES_MANAGER.test(code(file))).toBe(true);
	});
});
