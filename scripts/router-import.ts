import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decideImport, type ImportMarker, markerKey } from "../src/federation-server/migration/importDecision.js";
import { PRESERVED, violations } from "../src/federation-server/migration/importLayout.js";
import {
	declaredCounts,
	dedupeRows,
	unmappedRows,
	verifyCounts,
} from "../src/federation-server/migration/importVerify.js";
import { DomainQuota } from "../src/federation-server/owner/domainQuota.js";
import { OwnerStateStore } from "../src/federation-server/owner/ownerStateStore.js";
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

function main(): void {
	const file = fromFile();
	const bytes = fs.readFileSync(file);
	const parsed = MigrationExportSchema.safeParse(JSON.parse(bytes.toString("utf8")));
	if (!parsed.success) throw new Error(`invalid migration export: ${parsed.error.message}`);
	const snapshot = parsed.data;
	const digest = createHash("sha256").update(bytes).digest("hex");
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
	const federation = JSON.parse(fs.readFileSync(path.join(dataDir, "federation.json"), "utf8")) as {
		enrollment?: Record<string, { ownerSignPub?: string | null }>;
	};
	const ownerSignPub = federation.enrollment?.[snapshot.domainId]?.ownerSignPub;
	if (!ownerSignPub) throw new Error(`domain is not rooted: ${snapshot.domainId}`);
	const ownerId = ownerKeyId(ownerSignPub);
	const before: Record<string, string> = {};
	for (const name of PRESERVED) {
		const target = path.join(dataDir, name);
		before[name] = fs.existsSync(target) ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : "";
	}
	const quota = new DomainQuota({
		dir: dataDir,
		limitBytes: Number(process.env.ROUTER_DOMAIN_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
	});
	const store = OwnerStateStore.open({ dataDir, key: { domainId: snapshot.domainId, ownerSignPub }, quota });
	const written = { owners: snapshot.owners.length, board: 0, refusals: 0, rows: 0, cursorMap: 0, shares: 0 };
	try {
		for (const owner of snapshot.owners) {
			if (owner.ownerId !== ownerId) throw new Error(`owner mismatch: ${owner.ownerId}`);
			for (const item of owner.board) {
				const entry = item.entry as Record<string, unknown>;
				const clear = {
					id: entry.id,
					state: entry.state,
					rank: entry.rank,
					...(entry.parent ? { parent: entry.parent } : {}),
					...(item.session ? { session: item.session } : {}),
				};
				// The export sealed these at the gateway. The Router stores them without reading them.
				const result = store.put("board.entry", String(entry.id), null, { clear, sealed: item.sealed });
				if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`board write ${result.kind}`);
				written.board++;
			}
			written.refusals += owner.refusals.length;
			for (const box of owner.mailboxes) {
				const address = `owner:${snapshot.domainId}/${ownerSignPub}`;
				const existing = store.rows(address, 1, Number.MAX_SAFE_INTEGER).map((row) => row.row);
				// Deduped on the row's own key. The sealed text rides along untouched.
				const incoming = box.rows.map((entry) => ({ ...entry, dedupeKey: entry.row.dedupeKey }));
				for (const row of dedupeRows(existing as { dedupeKey?: string }[], incoming)) {
					const result = store.append(address, row as unknown as Record<string, unknown>);
					if (result.kind !== "ok") throw new Error(`mailbox write ${result.kind}`);
					written.rows++;
				}
				store.put("inbox.address", address, store.get("inbox.address", address)?.version ?? null, {
					clear: { epoch: box.epoch, cursorMap: box.cursorMap },
				});
				written.cursorMap += box.cursorMap.length;
			}
		}
		for (const share of snapshot.shares as Array<Record<string, unknown>>) {
			const id = `share:${String(share.sessionTarget)}|${JSON.stringify(share.target)}`;
			const result = store.put("share", id, null, { clear: share });
			if (result.kind !== "ok" && result.kind !== "conflict") throw new Error(`share write ${result.kind}`);
			written.shares++;
		}
		const failures = verifyCounts(declaredCounts(snapshot), written);
		if (failures.length) throw new Error(`count verification failed: ${JSON.stringify(failures)}`);
	} finally {
		store.close();
	}
	const after: Record<string, string> = {};
	for (const name of PRESERVED) {
		const target = path.join(dataDir, name);
		after[name] = fs.existsSync(target) ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : "";
	}
	const changed = violations(before, after);
	if (changed.length) throw new Error(`preserved files changed: ${changed.join(", ")}`);
	markers[key] = { digest, epoch: snapshot.epoch, gatewayId: snapshot.gatewayId, counts: declaredCounts(snapshot) };
	fs.writeFileSync(markerFile, JSON.stringify(markers, null, "\t"), { mode: 0o600 });
	console.log(JSON.stringify(markers[key]));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
