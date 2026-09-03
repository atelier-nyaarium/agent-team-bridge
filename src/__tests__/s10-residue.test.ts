import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import { DurableStore, openDurable } from "../shared/durable-store.js";
import {
	fenced,
	invalidate,
	MIGRATING,
	readGatewayMigrationWindow,
	useMigrationEpochFile,
} from "../shared/migration-fence.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const roots: string[] = [];
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s10-residue-"));
	roots.push(dir);
	return dir;
};

const delivery = (id: string) =>
	({ deliveryId: id, team: "team", channelJobId: "job", from: "from", body: "body", enqueuedAt: 1 }) as never;

afterEach(() => {
	delete process.env.DATA_DIR;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("S10 process fence", () => {
	it("fails closed on a malformed epoch file", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "migration-epoch"), "not-an-epoch\n");
		useMigrationEpochFile(dir);
		invalidate();
		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: null });
		expect(fenced()).toBe(true);
		fs.writeFileSync(path.join(dir, "migration-epoch"), "8-suffix\n");
		invalidate();
		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: null });
		expect(fenced()).toBe(true);
	});
	it("refuses every migrated writer under a real file fence and writes after removal", async () => {
		const dir = tempDir();
		process.env.DATA_DIR = dir;
		const owner = "owner";
		const board = openDurable(dir, "task-board", (store) => new BoardStore(store, new PlaneRegistry(), undefined));
		const pending = openDurable(dir, "pending-deliveries", (store) => new PendingDeliveryStore(store));
		const ops = new DurableOpStore(new DurableStore(dir, "console-ops"));
		const anchors = new ReadAnchors(new PlaneRegistry(), undefined);
		const shares = new CrossDomainShareState(dir);
		const push = createConsolePushOps({
			ownerId: () => owner,
			localGatewayId: "gateway",
			localAddress: (() => ({ canonical: "domain.gateway.team.session" })) as never,
			refuseImpersonation: () => null,
		});
		const relay = createGatewayRelayHandler({
			routes: {
				send: async () => new Response("{}"),
				respond: () => new Response("{}"),
				teams: () => new Response("[]"),
				localSpawnPoints: () => [],
				landCrossDomainPresence: () => {},
			},
			tryWakeTeam: async () => ({ ok: true }),
			localGatewayId: "gateway",
			localDomainId: "domain",
		});
		const entry = { id: "00000000000000000000000000000001", title: "title", state: "open", rank: "m" } as never;
		const target = { kind: "domain", domainId: "other" } as never;
		const file = path.join(dir, "migration-epoch");
		fs.writeFileSync(file, "8\n");
		useMigrationEpochFile(dir);
		invalidate();

		expect(pending.enqueue(delivery("fenced-pending"))).toBe("migrating");
		expect(ops.markInFlight("conversation", "fenced-op")).toBeNull();
		expect(board.upsert(owner, [entry], OWNER_ACTOR)).toEqual({ applied: false, migrating: true });
		expect(anchors.report(owner, "team", { epoch: 1, seq: 1, at: 1 })).toBe(false);
		expect(shares.unshare("session", target)).toBe(false);
		expect(
			push.deliverToOwner({
				entry: { kind: "notice" } as never,
				dedupeKey: "fenced-push",
			}),
		).toBe(MIGRATING);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({
			ok: false,
			error: "migrating",
		});

		fs.rmSync(file);
		invalidate();
		expect(pending.enqueue(delivery("live-pending"))).toBe("enqueued");
		expect(ops.markInFlight("conversation", "live-op")).toEqual(expect.any(Number));
		expect(board.upsert(owner, [entry], OWNER_ACTOR)).toEqual({ applied: true });
		expect(anchors.report(owner, "team", { epoch: 1, seq: 1, at: 1 })).toBe(true);
		shares.share("session", target);
		expect(shares.all()).toHaveLength(1);
		expect(
			push.deliverToOwner({
				entry: { kind: "notice" } as never,
				dedupeKey: "live-push",
			}),
		).toBe(true);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({ ok: true });
	});
});
