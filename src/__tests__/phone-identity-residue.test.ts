import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MAIN = path.join(
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
const DOOR = "PhoneIdentity.kt";
const STORE_WRITE =
	/\bstore\??\.(?:(?:save|saveIdentity|saveOwnerIdentity|saveDomainId|saveDomain|saveContentKeys|installApprovedDevice|replaceProvisioning|clearProvisioning)\(|(?:firstRooted|consoleAdmitted)\s*=[^=])/;
const STORE_WRITERS = new Set([DOOR, "FederationManager.kt", "crypto/ContentKeyring.kt"]);
const FEDERATION_WRITE =
	/\bfederation(?:\.|::)(importOwnerBackup|applyDomainSync|mergeAdmission|mergeRevocation|ensureContentEpochs|installContentKeys)\b/;
const ASSEMBLE = /\bPhoneBootstrap\.assemble\(/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const relative = (file: string) => path.relative(ANDROID_MAIN, file).split(path.sep).join("/");

describe("phone identity residue", () => {
	const files = kotlinFiles(ANDROID_MAIN);

	it("only the door and the slot owners write identity facts to the store", () => {
		expect(files.length).toBeGreaterThan(50);
		const writers = files.filter((f) => STORE_WRITE.test(code(f))).map(relative);
		expect(new Set(writers)).toEqual(STORE_WRITERS);
	});

	it("only the door drives the FederationManager's writes", () => {
		const writers = files
			.filter((f) => path.basename(f) !== "FederationManager.kt" && FEDERATION_WRITE.test(code(f)))
			.map(relative);
		expect(writers).toEqual([DOOR]);
	});

	it("only the door assembles the boot", () => {
		const assemblers = files.filter((f) => ASSEMBLE.test(code(f))).map(relative);
		expect(assemblers).toEqual([DOOR]);
	});
});
