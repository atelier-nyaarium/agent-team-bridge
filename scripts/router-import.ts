import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReferenceHeldStore } from "../src/federation-server/blobs/referenceHeldStore.js";
import { applyImport, type ImportStore } from "../src/federation-server/migration/applyImport.js";
import { importBlobArtifacts, validateBlobArtifacts } from "../src/federation-server/migration/blobTransfer.js";
import { decideImport, type ImportMarker, markerKey } from "../src/federation-server/migration/importDecision.js";
import { preservedDigests, violations, writeImportedEpoch } from "../src/federation-server/migration/importLayout.js";
import { missingKeyReceipts, validateOwners, validateShares } from "../src/federation-server/migration/importPolicy.js";
import {
	declaredCounts,
	dedupeRows,
	structureFaults,
	unmappedRows,
	verifyCounts,
	writtenCounts,
} from "../src/federation-server/migration/importVerify.js";
import { createLeaseService } from "../src/federation-server/migration/leaseService.js";
import {
	beginImport,
	declaredDigest,
	finishImport,
	parseSums,
	verifySums,
} from "../src/federation-server/migration/serveGate.js";
import { DomainQuota } from "../src/federation-server/owner/domainQuota.js";
import { OwnerLockHeld } from "../src/federation-server/owner/ownerLock.js";
import { OwnerStateStore } from "../src/federation-server/owner/ownerStateStore.js";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import { fingerprint } from "../src/shared/crypto.js";
import { MigrationBlobSchema, MigrationExportSchema } from "../src/shared/schemasMigration.js";

const dataDir = path.resolve(process.env.DATA_DIR || "/app/data");
const markerFile = path.join(dataDir, "import-marker.json");

function fromFile(): string {
	const index = process.argv.indexOf("--from");
	const file = index >= 0 ? process.argv[index + 1] : undefined;
	if (!file) throw new Error("usage: bun run scripts/router-import.ts --from <file>");
	return file;
}

function lockHolder(dataDir: string, domainId: string, ownerSignPub: string): number | null {
	try {
		const lock = JSON.parse(
			fs.readFileSync(path.join(dataDir, "owner", domainId, fingerprint(ownerSignPub), "owner.lock"), "utf8"),
		) as { pid?: unknown };
		return typeof lock.pid === "number" ? lock.pid : null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const file = path.resolve(fromFile());
	console.log(`from ${file} data ${path.resolve(dataDir)}`);
	const bytes = fs.readFileSync(file);
	const parsed = MigrationExportSchema.safeParse(JSON.parse(bytes.toString("utf8")));
	if (!parsed.success) throw new Error(`invalid migration export: ${parsed.error.message}`);
	const snapshot = parsed.data;
	const digest = createHash("sha256").update(bytes).digest("hex");
	// Require a named, matching digest.
	const sumsFile = path.join(path.dirname(file), "SHA256SUMS");
	if (!fs.existsSync(sumsFile)) throw new Error(`no SHA256SUMS beside ${path.basename(file)}`);
	const sumsText = fs.readFileSync(sumsFile, "utf8");
	const sumErrors = verifySums(path.dirname(file), sumsText);
	if (sumErrors.length) throw new Error(`SHA256SUMS verification failed: ${sumErrors.join(", ")}`);
	const declared = declaredDigest(parseSums(sumsText), path.basename(file));
	if (!declared) throw new Error(`SHA256SUMS does not name ${path.basename(file)}`);
	if (declared !== digest) throw new Error(`digest mismatch: declared ${declared}, found ${digest}`);
	const manifestFile = path.join(path.dirname(file), "blobs.json");
	if (!fs.existsSync(manifestFile)) throw new Error("blobs.json is missing");
	const manifestParsed = MigrationBlobSchema.array().safeParse(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
	if (!manifestParsed.success) throw new Error(`invalid blobs.json: ${manifestParsed.error.message}`);
	if (JSON.stringify(manifestParsed.data) !== JSON.stringify(snapshot.blobs ?? []))
		throw new Error("blobs.json does not match export");
	const sums = parseSums(sumsText);
	for (const blob of manifestParsed.data) {
		if (!sums[`blobs/${blob.blobId}`]) throw new Error(`SHA256SUMS does not name blobs/${blob.blobId}`);
	}
	const markers = fs.existsSync(markerFile)
		? (JSON.parse(fs.readFileSync(markerFile, "utf8")) as Record<string, ImportMarker>)
		: {};
	const key = markerKey(snapshot.gatewayId, snapshot.epoch);
	const verdict = decideImport({ digest, epoch: snapshot.epoch, gatewayId: snapshot.gatewayId }, markers[key]);
	if (verdict.kind === "noop") {
		const gate = path.join(dataDir, "import-in-progress");
		let canFinish = !fs.existsSync(gate);
		if (!canFinish) {
			try {
				const holder = JSON.parse(fs.readFileSync(gate, "utf8")) as { pid?: unknown };
				if (holder.pid === process.pid) canFinish = true;
				else if (typeof holder.pid === "number") {
					try {
						process.kill(holder.pid, 0);
					} catch {
						canFinish = true;
					}
				}
			} catch {}
		}
		if (canFinish) finishImport(dataDir);
		console.log(JSON.stringify(verdict.marker.counts));
		return;
	}
	if (verdict.kind === "refused") throw new Error(`epoch conflict: ${JSON.stringify(verdict.recorded)}`);
	const missing = unmappedRows(snapshot);
	if (missing.length)
		throw new Error(`unmapped rows: ${missing.map((row) => `${row.conversationId}/${row.oldSeq}`).join(", ")}`);
	const faults = structureFaults(snapshot);
	if (faults.length) throw new Error(`board structure: ${faults.map((f) => `${f.entryId} ${f.fault}`).join(", ")}`);
	const federation = JSON.parse(fs.readFileSync(path.join(dataDir, "federation.json"), "utf8")) as {
		identity: { sign: { priv: string; pub: string } };
		enrollment?: Record<string, import("../src/federation-server/federationSecret.js").EnrollmentState>;
	};
	const identity = federation.identity;
	const ownerPlans = snapshot.owners.map((owner) => {
		const domainId = owner.domainId ?? snapshot.domainId;
		if (domainId !== snapshot.domainId) throw new Error(`owner domain mismatch: ${domainId}`);
		const ownerSignPub = owner.ownerSignPub ?? federation.enrollment?.[domainId]?.ownerSignPub;
		const root = federation.enrollment?.[domainId]?.ownerSignPub;
		if (!ownerSignPub || !root || ownerSignPub !== root)
			throw new Error(`owner mismatch: ${domainId}/${owner.ownerSignPub ?? owner.ownerId}`);
		return { owner, domainId, ownerSignPub };
	});
	const ownerSignPub = federation.enrollment?.[snapshot.domainId]?.ownerSignPub;
	if (!ownerSignPub) throw new Error(`domain is not rooted: ${snapshot.domainId}`);
	const policyRefusals = [
		...validateOwners(snapshot, federation.enrollment ?? {}),
		...validateShares(snapshot, federation.enrollment ?? {}, snapshot.takenAt),
	];
	if (policyRefusals.length) throw new Error(`migration refusal: ${JSON.stringify(policyRefusals)}`);
	const blobErrors = validateBlobArtifacts(path.dirname(file), snapshot.blobs ?? []);
	if (blobErrors.length) throw new Error(`blob verification failed: ${blobErrors.join(", ")}`);
	const before = preservedDigests(dataDir);
	const quota = new DomainQuota({
		dir: dataDir,
		limitBytes: Number(process.env.ROUTER_DOMAIN_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
	});
	const stores: Array<{ plan: (typeof ownerPlans)[number]; store: OwnerStateStore }> = [];
	try {
		const blobReferences = new Map<string, string[]>();
		for (const plan of ownerPlans) {
			let store: OwnerStateStore;
			try {
				store = OwnerStateStore.open({
					dataDir,
					key: { domainId: plan.domainId, ownerSignPub: plan.ownerSignPub },
					quota,
				});
			} catch (error) {
				if (error instanceof OwnerLockHeld) {
					const pid = lockHolder(dataDir, plan.domainId, plan.ownerSignPub);
					throw new Error(
						`live Router owner lock held${pid === null ? "" : ` by pid ${pid}`} for ${plan.domainId}/${plan.ownerSignPub}`,
					);
				}
				throw error;
			}
			stores.push({ plan, store });
			const ownerSnapshot = {
				...snapshot,
				owners: [plan.owner],
				shares: plan.domainId === snapshot.domainId ? snapshot.shares : [],
			};
			const missingReceipts = missingKeyReceipts(ownerSnapshot, federation.enrollment ?? {}, (domainId, id) => {
				if (domainId !== plan.domainId) return null;
				return store.get("keyReceipt", id)?.clear ?? null;
			});
			if (missingReceipts.length)
				throw new Error(`missing key receipts for ${plan.domainId}: ${JSON.stringify(missingReceipts)}`);
		}
		beginImport(dataDir, `${snapshot.gatewayId}/${snapshot.epoch}`);
		for (const { plan, store } of stores) {
			const ownerSnapshot = {
				...snapshot,
				owners: [plan.owner],
				shares: plan.domainId === snapshot.domainId ? snapshot.shares : [],
			};
			const { addresses, blobReferences: ownerBlobReferences } = applyImport(
				store as unknown as ImportStore,
				ownerSnapshot,
				plan.ownerSignPub,
				dedupeRows,
				identity.sign.priv,
				identity.sign.pub,
			);
			for (const [blobId, refs] of ownerBlobReferences)
				blobReferences.set(blobId, [...(blobReferences.get(blobId) ?? []), ...refs]);
			const failures = verifyCounts(declaredCounts(ownerSnapshot), writtenCounts(store, addresses));
			if (failures.length)
				throw new Error(`count verification failed for ${plan.domainId}: ${JSON.stringify(failures)}`);
		}
		const blobs = snapshot.blobs ?? [];
		for (const blob of blobs) {
			if (blobReferences.has(blob.blobId)) continue;
			const owner = snapshot.owners[0]!;
			const refusal = { entryId: blob.blobId, sessionId: "", reason: "blob_missing" as const };
			owner.refusals.push(refusal);
			const store = stores[0]?.store;
			if (store) store.put("migration", `refusal:${owner.ownerId}:${blob.blobId}`, null, { clear: refusal });
		}
		if (blobs.length) {
			const held = new ReferenceHeldStore({ dataDir });
			importBlobArtifacts(path.dirname(file), held, snapshot, blobs, blobReferences);
		}
		const leases = createLeaseService({
			registry: {
				for: (domainId: string) => stores.find((item) => item.plan.domainId === domainId)!.store,
			} as never,
			migrationEpoch: () => snapshot.epoch,
		});
		const after = preservedDigests(dataDir);
		const changed = violations(before, after);
		if (changed.length) throw new Error(`preserved files changed: ${changed.join(", ")}`);
		markers[key] = {
			digest,
			epoch: snapshot.epoch,
			gatewayId: snapshot.gatewayId,
			counts: declaredCounts(snapshot),
		};
		writeFileAtomic(markerFile, JSON.stringify(markers, null, "\t"), {
			mode: 0o600,
			fsyncFile: true,
			fsyncDirectory: true,
		});
		writeImportedEpoch(dataDir, snapshot.epoch);
		leases.complete(snapshot.domainId, snapshot.gatewayId);
	} finally {
		for (const { store } of stores) store.close();
	}
	finishImport(dataDir);
	console.log(JSON.stringify(markers[key]));
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
