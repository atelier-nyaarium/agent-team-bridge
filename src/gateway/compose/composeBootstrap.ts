// Stage 1: the directories, the identity, the keyring, and the boot decision, before any store opens.

import { randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sweepAtomicTemps } from "../../shared/atomic-write.js";
import type { Identity } from "../../shared/crypto.js";
import { resolveLocalDomainId } from "../../shared/domain-id.js";
import { useMigrationEpochFile } from "../../shared/migration-fence.js";
import { type GatewayBoot, GatewayBootstrap } from "../boot.js";
import { recoverStaging } from "../federation/bootstrapInstall.js";
import { ContentKeyStore } from "../federation/contentKeyStore.js";
import { loadOrCreateIdentity } from "../federation/identity.js";
import { dueSchemaSteps, type SchemaStep, schemaVersionOf } from "../schemaWipe.js";
import type { GatewayDeps } from "./gatewayTypes.js";

export interface BootstrapStage {
	dataDir: string;
	logDir: string;
	federationDir: string;
	localGatewayId: string;
	now: () => number;
	randomBytes: (size: number) => Buffer;
	identity: () => Identity;
	contentKeyStore: ContentKeyStore;
	/** The boot decision made at construction. */
	gatewayBoot: GatewayBoot;
	initialDomainId: string | null;
	/** Re-reads the federation directory after an enrollment install. */
	resolveBoot: (enrollNonce: string | null) => GatewayBoot;
}

export function composeBootstrap(deps: GatewayDeps): BootstrapStage {
	const { config } = deps;
	const now = deps.now ?? Date.now;
	const randomBytes = deps.randomBytes ?? nodeRandomBytes;
	const dataDir = config.dataDir;
	const logDir = config.logDir;
	const federationDir = config.federationDir;
	const localGatewayId = config.gatewayId;

	// Install the migration fence before constructing durable writers.
	useMigrationEpochFile(dataDir);
	fs.mkdirSync(dataDir, { recursive: true });
	console.log(`[gateway] Gateway id: ${localGatewayId}`);
	recoverStaging(federationDir);
	for (const name of sweepAtomicTemps(federationDir)) console.log(`[gateway] removed atomic temp ${name}`);

	let cachedIdentity: Identity | null = null;
	const identity = () => (cachedIdentity ??= loadOrCreateIdentity(federationDir));
	const contentKeyStore = new ContentKeyStore(federationDir, () => identity().box.priv, randomBytes);

	const resolveBoot = (enrollNonce: string | null): GatewayBoot =>
		GatewayBootstrap.resolve(
			{ federationDir },
			{
				enrollNonce,
				allowFixtureIdentity: deps.allowFixtureIdentity ?? false,
				domainIdEnv: process.env.FEDERATION_DOMAIN_ID,
			},
			{ identity, contentKeys: contentKeyStore },
		);

	const gatewayBoot = resolveBoot(config.enrollNonce ?? null);
	const initialDomainId =
		gatewayBoot.kind === "active" ? gatewayBoot.boot.domainId : resolveLocalDomainId(federationDir);
	console.log(`[gateway] Domain id: ${initialDomainId ?? "(none - not yet enrolled)"}`);

	wipeRetiredSchemas({ dataDir, logDir, federationDir });

	return {
		dataDir,
		logDir,
		federationDir,
		localGatewayId,
		now,
		randomBytes,
		identity,
		contentKeyStore,
		gatewayBoot,
		initialDomainId,
		resolveBoot,
	};
}

function wipeRetiredSchemas(dirs: { dataDir: string; logDir: string; federationDir: string }): void {
	const steps: ReadonlyArray<SchemaStep> = [
		{
			version: 2,
			files: [
				path.join(dirs.dataDir, "pending-jobs.json"),
				path.join(dirs.dataDir, "mailboxes.json"),
				path.join(dirs.logDir, "pending-jobs.json"),
				path.join(dirs.logDir, "mailboxes.json"),
				path.join(dirs.federationDir, "cross-domain-share-state.json"),
			],
		},
		// Nothing opens either store.
		{ version: 3, files: [path.join(dirs.dataDir, "mailboxes.json"), path.join(dirs.dataDir, "task-board.json")] },
	];
	const latest = steps[steps.length - 1]!.version;
	try {
		const sentinelPath = path.join(dirs.dataDir, "schema-version");
		const current = schemaVersionOf(fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, "utf8") : null);
		for (const step of dueSchemaSteps(current, steps)) {
			for (const file of step.files) fs.rmSync(file, { force: true });
			console.log(`[schema-wipe] step ${step.version}: removed ${step.files.length} retired files`);
		}
		if (current !== latest) fs.writeFileSync(sentinelPath, String(latest));
	} catch (err) {
		console.error("[schema-wipe] failed:", err);
	}
}
