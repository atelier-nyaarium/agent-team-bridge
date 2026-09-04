import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Guard signing key reachability. */
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

/** Allowed callers. The repository's own hosts, ports, and adapters count as the repository. */
const ALLOWED = [
	"PhoneBootstrap.kt",
	"PhoneIdentity.kt",
	"ChatRepository.kt",
	"DeviceApprovalOps.kt",
	"GatewayEnrollment.kt",
	"OwnerFacts.kt",
	"RepositoryCollaborators.kt",
	"RepositoryPorts.kt",
	"TrustOps.kt",
];

/** Declaring file. */
const DECLARING_FILE = "FederationManager.kt";

/** Manager access patterns. */
const REACHES_MANAGER = /(^|[^\w.])federation\s*\.|\.federation\b/;

/** Strip comments and literals. */
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

describe("only the repository and its federation collaborators reach FederationManager", () => {
	it("no other source touches it", () => {
		const callers = kotlinSources()
			.filter((f) => REACHES_MANAGER.test(code(f)))
			.map((f) => path.basename(f))
			.sort();

		expect(callers).toEqual([...ALLOWED].sort());
	});

	it.each(ALLOWED)("%s really does reach it, so the guard above is proving something", (file) => {
		expect(REACHES_MANAGER.test(code(file))).toBe(true);
	});
});
