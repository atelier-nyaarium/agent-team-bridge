import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyImport, type ImportStore } from "../src/federation-server/migration/applyImport.js";
import { decideImport, type ImportMarker, markerKey } from "../src/federation-server/migration/importDecision.js";
import { preservedDigests, violations } from "../src/federation-server/migration/importLayout.js";
import {
	declaredCounts,
	dedupeRows,
	structureFaults,
	unmappedRows,
	verifyCounts,
	writtenCounts,
} from "../src/federation-server/migration/importVerify.js";
import { beginImport, declaredDigest, finishImport, parseSums } from "../src/federation-server/migration/serveGate.js";
import { DomainQuota } from "../src/federation-server/owner/domainQuota.js";
import { OwnerLockHeld } from "../src/federation-server/owner/ownerLock.js";
import { OwnerStateStore } from "../src/federation-server/owner/ownerStateStore.js";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import { ownerKeyId } from "../src/shared/owner-id.js";
import { MigrationExportSchema } from "../src/shared/schemasMigration.js";

const dataDir = process.env.DATA_DIR || "/app/data";
const markerFile = path.join(dataDir, "import-marker.json");

function fromFile(): string {
	const index = process.argv.indexOf("--from");
	const file = index >= 0 ? process.argv[index + 1] : undefined;
	if (!file) throw new Error("usage: bun run scripts/router-import.ts --from <file>");
	return file;
}

async function main(): Promise<void> {
	const file = fromFile();
	const bytes = fs.readFileSync(file);
	const parsed = MigrationExportSchema.safeParse(JSON.parse(bytes.toString("utf8")));
	if (!parsed.success) throw new Error(`invalid migration export: ${parsed.error.message}`);
	const snapshot = parsed.data;
	const digest = createHash("sha256").update(bytes).digest("hex");
	// Require a named, matching digest.
	const sumsFile = path.join(path.dirname(file), "SHA256SUMS");
	if (!fs.existsSync(sumsFile)) throw new Error(`no SHA256SUMS beside ${path.basename(file)}`);
	const declared = declaredDigest(parseSums(fs.readFileSync(sumsFile, "utf8")), path.basename(file));
	if (!declared) throw new Error(`SHA256SUMS does not name ${path.basename(file)}`);
	if (declared !== digest) throw new Error(`digest mismatch: declared ${declared}, found ${digest}`);
	const markers = fs.existsSync(markerFile)
		? (JSON.parse(fs.readFileSync(markerFile, "utf8")) as Record<string, ImportMarker>)
		: {};
	const key = markerKey(snapshot.gatewayId, snapshot.epoch);
	const verdict = decideImport({ digest, epoch: snapshot.epoch, gatewayId: snapshot.gatewayId }, markers[key]);
	if (verdict.kind === "noop") {
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
		enrollment?: Record<string, { ownerSignPub?: string | null }>;
	};
	const ownerSignPub = federation.enrollment?.[snapshot.domainId]?.ownerSignPub;
	if (!ownerSignPub) throw new Error(`domain is not rooted: ${snapshot.domainId}`);
	const ownerId = ownerKeyId(ownerSignPub);
	const before = preservedDigests(dataDir);
	// Keep the Router gated until verification.
	beginImport(dataDir, `${snapshot.gatewayId}/${snapshot.epoch}`);
	const quota = new DomainQuota({
		dir: dataDir,
		limitBytes: Number(process.env.ROUTER_DOMAIN_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
	});
	let store: OwnerStateStore;
	try {
		store = OwnerStateStore.open({ dataDir, key: { domainId: snapshot.domainId, ownerSignPub }, quota });
	} catch (error) {
		if (error instanceof OwnerLockHeld)
			throw new Error(
				`live Router owner lock held by pid ${readLockPid(dataDir, snapshot.domainId, ownerSignPub)}`,
			);
		throw error;
	}
	try {
		for (const owner of snapshot.owners)
			if (owner.ownerId !== ownerId) throw new Error(`owner mismatch: ${owner.ownerId}`);
		const { addresses } = applyImport(
			store as unknown as ImportStore,
			snapshot,
			ownerSignPub,
			dedupeRows,
			(
				JSON.parse(fs.readFileSync(path.join(dataDir, "federation.json"), "utf8")) as {
					identity: { sign: { priv: string; pub: string } };
				}
			).identity.sign.priv,
			(
				JSON.parse(fs.readFileSync(path.join(dataDir, "federation.json"), "utf8")) as {
					identity: { sign: { priv: string; pub: string } };
				}
			).identity.sign.pub,
		);
		// Verify persisted state.
		const failures = verifyCounts(declaredCounts(snapshot), writtenCounts(store, addresses));
		if (failures.length) throw new Error(`count verification failed: ${JSON.stringify(failures)}`);
	} finally {
		store.close();
	}
	const after = preservedDigests(dataDir);
	const changed = violations(before, after);
	if (changed.length) throw new Error(`preserved files changed: ${changed.join(", ")}`);
	markers[key] = { digest, epoch: snapshot.epoch, gatewayId: snapshot.gatewayId, counts: declaredCounts(snapshot) };
	writeFileAtomic(markerFile, JSON.stringify(markers, null, "\t"), {
		mode: 0o600,
		fsyncFile: true,
		fsyncDirectory: true,
	});
	finishImport(dataDir);
	console.log(JSON.stringify(markers[key]));
}

function readLockPid(dataDir: string, domainId: string, ownerSignPub: string): string {
	const file = path.join(dataDir, "owner", domainId, ownerKeyId(ownerSignPub), "owner.lock");
	try {
		return String((JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number }).pid ?? "unknown");
	} catch {
		return "unknown";
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
