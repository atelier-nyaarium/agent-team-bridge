import fs from "node:fs";
import path from "node:path";
import { OwnerStoreRegistry } from "../src/federation-server/inbox/ownerStoreRegistry.js";
import { createLeaseService, routerMigrationEpoch } from "../src/federation-server/migration/leaseService.js";
import { DomainQuota } from "../src/federation-server/owner/domainQuota.js";
import { OwnerLockHeld } from "../src/federation-server/owner/ownerLock.js";

const dataDir = process.env.DATA_DIR || "/app/data";
const states = new Set(["active", "offline", "retired", "excluded"]);

function arg(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value)
		throw new Error(
			`usage: bun run scripts/router-lease.ts --domain <id> --gateway <id> --state active|offline|retired|excluded`,
		);
	return value;
}

function ownerOf(domainId: string): string | null {
	try {
		const federation = JSON.parse(fs.readFileSync(path.join(dataDir, "federation.json"), "utf8")) as {
			enrollment?: Record<string, { ownerSignPub?: string | null }>;
		};
		return federation.enrollment?.[domainId]?.ownerSignPub ?? null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const domainId = arg("--domain");
	const gatewayId = arg("--gateway");
	const state = arg("--state");
	console.log(`data ${path.resolve(dataDir)}`);
	if (!states.has(state)) throw new Error(`invalid lease state: ${state}`);
	const epoch = routerMigrationEpoch();
	if (epoch === 0) throw new Error("migration epoch must be positive");
	const ownerSignPub = ownerOf(domainId);
	if (!ownerSignPub) throw new Error(`domain is not rooted: ${domainId}`);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId ? ownerSignPub : null),
		quotaFor: () =>
			new DomainQuota({
				dir: dataDir,
				limitBytes: Number(process.env.ROUTER_DOMAIN_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
			}),
	});
	try {
		const leases = createLeaseService({ registry, migrationEpoch: () => epoch });
		leases.put(domainId, gatewayId, state as "active" | "offline" | "retired" | "excluded");
		console.log(JSON.stringify(leases.read(domainId, gatewayId)));
	} catch (error) {
		if (error instanceof OwnerLockHeld) throw new Error(`live Router owner lock held`);
		throw error;
	} finally {
		registry.close();
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
