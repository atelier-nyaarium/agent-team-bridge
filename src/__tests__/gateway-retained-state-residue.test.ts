import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guards the owner-state boundary.

const ROOT = path.resolve(import.meta.dirname, "..");

const RETAINED: Record<string, string[]> = {
	"session store": ["shared/session-store.ts"],
	"Codex catalogs and threads": ["shared/session-store.ts"],
	"Copilot catalogs and threads": ["shared/session-store.ts"],
	"pending jobs": ["shared/pending-job-store.ts"],
	ReplayGuard: ["gateway/federation/replayGuard.ts"],
	"origin blob copies": ["shared/blob-store.ts"],
	identity: ["gateway/federation/identity.ts"],
	admissions: ["gateway/federation/allowlist.ts"],
	crossDomainPeers: ["gateway/federation/crossDomainPeers.ts"],
	sealer: ["gateway/federation/sealer.ts"],
	"awareness delivery adapter": ["gateway/awarenessBank.ts"],
	"daemon capability source": ["gateway/daemonCapabilities.ts"],
};

/** State leaving the gateway, with current consumers. */
const LEAVING: Record<string, string[]> = {
	"gateway/console/capabilityStore.ts": [
		"gateway/composeGateway.ts",
		"gateway/console/consoleDevices.ts",
		"gateway/console/consoleTypes.ts",
	],
	"shared/plane-registry.ts": [
		"gateway/composeGateway.ts",
		"gateway/boardAwareness.ts",
		"gateway/presence.ts",
		"gateway/readAnchors.ts",
		"gateway/console/consoleTypes.ts",
		"gateway/console/pollPlanes.ts",
		"gateway/federation/crossDomainPresence.ts",
		"shared/presence-identity.ts",
	],
	"gateway/readAnchors.ts": [
		"gateway/composeGateway.ts",
		"gateway/console/consoleHandler.ts",
		"gateway/console/consoleTypes.ts",
		"gateway/console/pollPlanes.ts",
	],
	"gateway/federation/crossDomainShareState.ts": ["gateway/composeGateway.ts", "gateway/boot.ts"],
	"gateway/console/durableOpStore.ts": [
		"gateway/composeGateway.ts",
		"gateway/routes.ts",
		"gateway/console/consoleTypes.ts",
	],
};

const UNMAPPED_LEAVING = ["awareness generation"];

const MIGRATED_ONCE: Record<string, string> = {
	"shared/pending-delivery-store.ts": "Retire after Phase 8 migration.",
};

const DISCARDED_AFTER: Record<string, string> = {
	"gateway/console/durableOpStore.ts": "Retire after the migration fence.",
};

function sourceFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts")) out.push(path.relative(ROOT, full));
		}
	};
	walk(path.join(ROOT, "gateway"));
	walk(path.join(ROOT, "shared"));
	return out;
}

/** Files importing `module`. */
function importersOf(module: string, files: string[]): string[] {
	const specifier = `${path.basename(module, ".ts")}.js`;
	const found: string[] = [];
	for (const file of files) {
		if (file === module) continue;
		const text = fs.readFileSync(path.join(ROOT, file), "utf8");
		for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
			const target = match[1];
			if (!target.endsWith(specifier)) continue;
			const resolved = path.normalize(path.join(path.dirname(file), target)).replace(/\.js$/, ".ts");
			if (resolved === module) {
				found.push(file);
				break;
			}
		}
	}
	return found.sort();
}

describe("gateway retained state", () => {
	const files = sourceFiles();

	it("keeps every store it physically owns", () => {
		for (const [item, modules] of Object.entries(RETAINED)) {
			for (const module of modules) {
				expect(fs.existsSync(path.join(ROOT, module)), `${item}: ${module} is gone`).toBe(true);
				expect(importersOf(module, files).length, `${item}: ${module} has no consumer left`).toBeGreaterThan(0);
			}
		}
	});

	it("lets owner state on its way out only lose consumers", () => {
		for (const [module, pinned] of Object.entries(LEAVING)) {
			if (!fs.existsSync(path.join(ROOT, module))) continue;
			const actual = importersOf(module, files);
			const added = actual.filter((file) => !pinned.includes(file));
			expect(added, `${module} gained a consumer; owner state on its way out must only shrink`).toEqual([]);
		}
	});

	it("keeps migration and discard sources until their retirement points", () => {
		for (const [module, retirement] of Object.entries(MIGRATED_ONCE)) {
			// Retire only after Phase 8 import verification.
			expect(fs.existsSync(path.join(ROOT, module)), `${module} is gone: ${retirement}`).toBe(true);
		}
		for (const [module, retirement] of Object.entries(DISCARDED_AFTER)) {
			// Retire only after the migration fence.
			expect(fs.existsSync(path.join(ROOT, module)), `${module} is gone: ${retirement}`).toBe(true);
		}
	});

	it("records inventory items without a single module", () => {
		expect(UNMAPPED_LEAVING).toEqual(["awareness generation"]);
	});

	it("does not retain the legacy gateway board store", () => {
		expect(fs.existsSync(path.join(ROOT, "gateway/boardStore.ts"))).toBe(false);
		expect(importersOf("gateway/boardStore.ts", files)).toEqual([]);
	});
});
