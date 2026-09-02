import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BoardStore } from "../src/gateway/boardStore.js";
import { CrossDomainShareState } from "../src/gateway/federation/crossDomainShareState.js";
import { buildExport } from "../src/gateway/migration/exportSnapshot.js";
import { ReadAnchors } from "../src/gateway/readAnchors.js";
import { DeviceMailboxStore } from "../src/shared/device-mailbox.js";
import { resolveLocalDomainId } from "../src/shared/domain-id.js";
import { DurableStore, openDurable } from "../src/shared/durable-store.js";
import { resolveLocalGatewayId } from "../src/shared/gateway-id.js";
import { fenced, useMigrationEpochFile } from "../src/shared/migration-fence.js";
import { ownerKeyId } from "../src/shared/owner-id.js";
import { PendingDeliveryStore } from "../src/shared/pending-delivery-store.js";
import type { PlanePersistedState } from "../src/shared/plane-registry.js";
import { PlaneRegistry } from "../src/shared/plane-registry.js";
import { SessionStore } from "../src/shared/session-store.js";

const dataDir = process.env.DATA_DIR || "/app/data";

function argument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`usage: bun run scripts/gateway-export.ts --epoch <N> [--out <dir>]`);
	return value;
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

function main(): void {
	const epoch = Number(argument("--epoch"));
	if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`invalid epoch: ${epoch}`);
	const outDir = process.argv.includes("--out") ? argument("--out") : dataDir;
	useMigrationEpochFile(dataDir);
	if (!fenced()) throw new Error("migration fence is not up; refusing to export live state");

	const federationDir = process.env.FEDERATION_DIR || path.join(dataDir, "federation");
	const domainId = resolveLocalDomainId(federationDir);
	if (!domainId) throw new Error("gateway is not enrolled; no local domain id");
	const gatewayId = resolveLocalGatewayId();
	const allowlist = readJson(path.join("federation", "federation-allowlist.json"));
	const ownerSignPub = (allowlist as { ownerSignPub?: string | null } | null)?.ownerSignPub;
	const localOwnerId = ownerSignPub ? ownerKeyId(ownerSignPub) : null;

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
	const anchorData = resume && typeof resume === "object" && "readAnchors" in resume ? resume.readAnchors : undefined;
	anchors.restore(anchorData);
	const board = openDurable(dataDir, "task-board", (d) => new BoardStore(d, planeRegistry, planes));
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
			ownerIds: () => [...owners],
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

	const bytes = Buffer.from(JSON.stringify(snapshot, null, "\t"));
	fs.mkdirSync(outDir, { recursive: true });
	const file = path.join(outDir, `export-${epoch}.json`);
	fs.writeFileSync(file, bytes, { mode: 0o600 });
	fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${digest(bytes)}  ${path.basename(file)}\n`, { mode: 0o600 });
	const counts = {
		owners: snapshot.owners.length,
		board: snapshot.owners.reduce((n, owner) => n + owner.board.length, 0),
		mailboxes: snapshot.owners.reduce((n, owner) => n + owner.mailboxes.length, 0),
		rows: snapshot.owners.reduce((n, owner) => n + owner.mailboxes.reduce((m, box) => m + box.rows.length, 0), 0),
		pending: snapshot.owners.reduce((n, owner) => n + owner.pending.length, 0),
		shares: snapshot.shares.length,
		refusals: snapshot.owners.reduce((n, owner) => n + owner.refusals.length, 0),
	};
	console.log(JSON.stringify(counts));
	for (const refusal of snapshot.owners.flatMap((owner) => owner.refusals))
		console.log(`refused ${refusal.entryId}: ${refusal.sessionId}`);
	console.log(`wrote ${file}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
