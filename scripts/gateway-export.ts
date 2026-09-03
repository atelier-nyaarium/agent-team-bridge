import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BoardStore } from "../src/gateway/boardStore.js";
import { ContentKeyStore } from "../src/gateway/federation/contentKeyStore.js";
import { CrossDomainShareState } from "../src/gateway/federation/crossDomainShareState.js";
import { loadOrCreateIdentity } from "../src/gateway/federation/identity.js";
import { writeBlobArtifacts } from "../src/gateway/migration/blobArtifacts.js";
import { buildExport } from "../src/gateway/migration/exportSnapshot.js";
import { ReadAnchors } from "../src/gateway/readAnchors.js";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import { BoardAttachmentStore } from "../src/shared/board-attachment-store.js";
import { DeviceMailboxStore } from "../src/shared/device-mailbox.js";
import { resolveLocalDomainId } from "../src/shared/domain-id.js";
import { DurableStore, openDurable } from "../src/shared/durable-store.js";
import { resolveLocalGatewayId } from "../src/shared/gateway-id.js";
import {
	MIGRATION_SETTLE_MS,
	readGatewayMigrationWindow,
	readMigrationFenceRaisedAt,
	useMigrationEpochFile,
	withMigrationInProgress,
} from "../src/shared/migration-fence.js";
import { ownerKeyId } from "../src/shared/owner-id.js";
import { PendingDeliveryStore } from "../src/shared/pending-delivery-store.js";
import type { PlanePersistedState } from "../src/shared/plane-registry.js";
import { PlaneRegistry } from "../src/shared/plane-registry.js";
import type { MigrationExport } from "../src/shared/schemasMigration.js";
import { SessionStore } from "../src/shared/session-store.js";

const dataDir = process.env.DATA_DIR || "/app/data";
useMigrationEpochFile(dataDir);

function argument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`usage: bun run scripts/gateway-export.ts --epoch <N> [--out <dir>]`);
	return value;
}

function epochArgument(): number {
	const value = argument("--epoch");
	if (!/^[1-9][0-9]*$/.test(value))
		throw new Error("usage: bun run scripts/gateway-export.ts --epoch <N> [--out <dir>]");
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch))
		throw new Error("usage: bun run scripts/gateway-export.ts --epoch <N> [--out <dir>]");
	return epoch;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function readJson(name: string): unknown {
	const file = path.join(dataDir, name);
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function mergeSums(outDir: string, additions: string[]): void {
	const sumsFile = path.join(outDir, "SHA256SUMS");
	const merged = new Map<string, string>();
	if (fs.existsSync(sumsFile)) {
		for (const line of fs
			.readFileSync(sumsFile, "utf8")
			.split("\n")
			.filter((line) => line.trim())) {
			const separator = line.indexOf("  ");
			if (separator < 0) throw new Error(`invalid SHA256SUMS line: ${line}`);
			const name = line.slice(separator + 2);
			if (merged.has(name)) throw new Error(`duplicate SHA256SUMS entry: ${name}`);
			if (fs.existsSync(path.join(outDir, name))) merged.set(name, line);
		}
	}
	for (const line of additions) merged.set(line.slice(line.indexOf("  ") + 2), line);
	writeFileAtomic(sumsFile, `${[...merged.values()].join("\n")}\n`, { mode: 0o600 });
}

function main(): void {
	const epoch = epochArgument();
	const outDir = path.resolve(process.argv.includes("--out") ? argument("--out") : dataDir);
	console.log(`output ${outDir}`);
	withMigrationInProgress(dataDir, () => {
		const window = readGatewayMigrationWindow();
		if (!window.fenced) throw new Error("migration fence is not up; refusing to export live state");
		if (window.epoch === null) throw new Error("migration fence has malformed epoch");
		const currentEpoch = window.epoch;
		if (currentEpoch !== epoch)
			throw new Error(`migration epoch mismatch: fence=${currentEpoch} argument=${epoch}`);
		const raisedAt = readMigrationFenceRaisedAt(dataDir);
		if (raisedAt === null || Date.now() - raisedAt < MIGRATION_SETTLE_MS)
			throw new Error(
				`migration fence has not settled; remaining seconds: ${Math.ceil((MIGRATION_SETTLE_MS - (raisedAt === null ? 0 : Date.now() - raisedAt)) / 1000)}`,
			);

		const federationDir = process.env.FEDERATION_DIR || path.join(dataDir, "federation");
		const domainId = resolveLocalDomainId(federationDir);
		if (!domainId) throw new Error("gateway is not enrolled; no local domain id");
		const gatewayId = resolveLocalGatewayId();
		const allowlist = readJson(path.join("federation", "federation-allowlist.json"));
		const ownerSignPub = (allowlist as { ownerSignPub?: string | null } | null)?.ownerSignPub;
		const localOwnerId = ownerSignPub ? ownerKeyId(ownerSignPub) : null;
		if (!ownerSignPub) throw new Error("gateway holds no owner key; refusing to export readable text");
		const keys = new ContentKeyStore(federationDir, () => loadOrCreateIdentity(federationDir).box.priv);

		const sessionDurable = new DurableStore(dataDir, "session-resume");
		const sessionStore = new SessionStore();
		const resume = sessionDurable.load();
		sessionStore.restore(
			resume && typeof resume === "object" && "sessions" in resume
				? (resume as { sessions?: unknown }).sessions
				: resume,
		);
		const planes =
			resume && typeof resume === "object" && "planes" in resume
				? (resume as { planes?: Record<string, PlanePersistedState> }).planes
				: undefined;
		const planeRegistry = new PlaneRegistry();
		const anchors = new ReadAnchors(planeRegistry, planes);
		const anchorData =
			resume && typeof resume === "object" && "readAnchors" in resume ? resume.readAnchors : undefined;
		anchors.restore(anchorData);
		const board = openDurable(dataDir, "task-board", (d) => new BoardStore(d, planeRegistry, planes));
		const boardAttachments = new BoardAttachmentStore(path.join(dataDir, "board-attachments"));
		const mailboxes = new DeviceMailboxStore();
		const mailboxData = new DurableStore(dataDir, "mailboxes").load();
		if (mailboxData && typeof mailboxData === "object")
			mailboxes.restore(mailboxData as Parameters<DeviceMailboxStore["restore"]>[0]);
		const pending = openDurable(dataDir, "pending-deliveries", (d) => new PendingDeliveryStore(d));
		const shares = new CrossDomainShareState(federationDir);
		const owners = new Set(board.ownerIds());
		for (const ownerId of Object.keys(mailboxes.snapshot())) owners.add(ownerId);
		for (const ownerId of Object.keys(anchors.snapshot())) owners.add(ownerId);
		if (localOwnerId) owners.add(localOwnerId);
		const deliveryRows = pending.snapshot().deliveries;

		const snapshot = buildExport(
			{
				domainId,
				gatewayId,
				// Gateway-owned key access.
				// Kinds are already bound.
				seal: (plaintext, kind) => {
					const sealed = keys.seal(Buffer.from(plaintext, "utf8"), { domainId, ownerSignPub, kind }, 1);
					if (sealed.kind === "no_key") throw new Error("migration export requires content key epoch 1");
					return sealed.kind === "ok" ? sealed.envelope : null;
				},
				ownerIds: () => [...owners],
				ownerInfo: (ownerId) => ({ domainId, ownerSignPub }),
				boardEntries: (ownerId) => board.allEntries(ownerId),
				holdsSession: (sessionId) =>
					sessionStore
						.list()
						.some((record) => record.id === sessionId || sessionStore.teamOf(record) === sessionId),
				mailboxes: (ownerId) => {
					const state = mailboxes.get(ownerId)?.snapshot();
					return state
						? [
								{
									conversationId: ownerId,
									epoch: state.epoch,
									rows: state.entries,
									consumerCursors: state.consumerCursors ?? [],
								},
							]
						: [];
				},
				pending: (ownerId) => (ownerId === localOwnerId ? deliveryRows : []),
				readAnchors: (ownerId) => anchors.snapshot()[ownerId] ?? {},
				shares: () => shares.all(),
				now: Date.now,
			},
			epoch,
		);

		fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(outDir, 0o700);
		const contentKey = keys.keyFor(1);
		if (!contentKey) throw new Error("migration export requires content key epoch 1");
		const blobResult = writeBlobArtifacts(
			snapshot,
			outDir,
			(blobId) => boardAttachments.readAny(blobId, 0, Number.MAX_SAFE_INTEGER)?.bytes ?? null,
			contentKey,
			ownerSignPub,
		);
		for (const owner of snapshot.owners) {
			for (const item of owner.board) {
				const missing = new Set(
					(item.entry.attachments ?? [])
						.filter((attachment) => blobResult.missing.includes(attachment.blobId))
						.map((attachment) => attachment.blobId),
				);
				if (!missing.size) continue;
				const { attachments: _attachments, ...entry } = item.entry;
				const kept = item.entry.attachments?.filter((attachment) => !missing.has(attachment.blobId)) ?? [];
				item.entry = { ...entry, ...(kept.length ? { attachments: kept } : {}) };
				if (item.sealed.names) {
					const names = Object.fromEntries(
						Object.entries(item.sealed.names).filter(([blobId]) => !missing.has(blobId)),
					);
					item.sealed = { ...item.sealed, ...(Object.keys(names).length ? { names } : { names: undefined }) };
				}
			}
		}
		for (const blobId of blobResult.missing)
			snapshot.owners[0]?.refusals.push({ entryId: blobId, sessionId: "", reason: "blob_missing" });
		(snapshot as MigrationExport & { blobs?: unknown }).blobs = blobResult.manifest;
		const bytes = Buffer.from(JSON.stringify(snapshot, null, "\t"));
		const file = path.join(outDir, `export-${epoch}.json`);
		writeFileAtomic(file, bytes, { mode: 0o600 });
		const additions = [
			`${digest(bytes)}  ${path.basename(file)}`,
			`${digest(Buffer.from(JSON.stringify(blobResult.manifest, null, "\t")))}  blobs.json`,
		];
		for (const item of blobResult.manifest)
			additions.push(`${digest(fs.readFileSync(path.join(outDir, "blobs", item.blobId)))}  blobs/${item.blobId}`);
		mergeSums(outDir, additions);
		const counts = {
			owners: snapshot.owners.length,
			board: snapshot.owners.reduce((n, owner) => n + owner.board.length, 0),
			mailboxes: snapshot.owners.reduce((n, owner) => n + owner.mailboxes.length, 0),
			rows: snapshot.owners.reduce(
				(n, owner) => n + owner.mailboxes.reduce((m, box) => m + box.rows.length, 0),
				0,
			),
			shares: snapshot.shares.length,
			refusals: snapshot.owners.reduce((n, owner) => n + owner.refusals.length, 0),
		};
		console.log(JSON.stringify(counts));
		for (const refusal of snapshot.owners.flatMap((owner) => owner.refusals))
			console.log(`refused ${refusal.entryId}: ${refusal.sessionId}`);
		console.log(`wrote ${file}`);
	});
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
