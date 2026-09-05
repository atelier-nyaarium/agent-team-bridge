import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import { processAmbient } from "../shared/ambient.js";
import { DurableStore, openDurable } from "../shared/durable-store.js";
import { invalidate, MIGRATING, readGatewayMigrationWindow, useMigrationEpochFile } from "../shared/migration-fence.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Delivery-state durability

describe("delivery-state durability", () => {
	it("persistent job anchors (and their stored result) survive snapshot/restore", () => {
		const a = new PendingJobStore<string>(600_000, processAmbient());
		a.create("conv:c1:host/team", "Aqua", "host/team", { persistent: true, fromConversationId: "c1" });
		a.deliver("conv:c1:host/team", "hello"); // async (channel) delivery -> stored
		a.create("transient", "x", "y"); // non-persistent: must NOT survive

		const snap = a.snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0].id).toBe("conv:c1:host/team");

		const b = new PendingJobStore<string>(600_000, processAmbient());
		b.restore(snap);
		expect(b.poll("conv:c1:host/team")).toBe("hello"); // anchor + result survived
		expect(b.has("transient")).toBe(false);
	});

	it("a restore never clobbers a live entry that beat the load", () => {
		const a = new PendingJobStore<string>(600_000, processAmbient());
		a.create("conv:x", "from", "to", { persistent: true });
		a.deliver("conv:x", "old");
		const snap = a.snapshot();

		const b = new PendingJobStore<string>(600_000, processAmbient());
		b.create("conv:x", "from", "to", { persistent: true });
		b.deliver("conv:x", "fresh"); // a registration raced the restore
		b.restore(snap);
		expect(b.poll("conv:x")).toBe("fresh"); // the live entry wins
	});
});

describe("migration fence durability", () => {
	it("refuses durable writers while fenced and accepts them after removal", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-fence-"));
		roots.push(dir);
		const ambient = processAmbient();
		const pending = openDurable(dir, "pending-deliveries", (store) => new PendingDeliveryStore(store, ambient));
		const ops = new DurableOpStore(new DurableStore(dir, "console-ops"), ambient);
		const anchors = new ReadAnchors(new PlaneRegistry(ambient), undefined);
		const shares = new CrossDomainShareState(dir, undefined, ambient);
		const push = createConsolePushOps({
			dataDir: dir,
			ownerId: () => "owner",
			localGatewayId: "gateway",
			localAddress: (() => ({ canonical: "domain.gateway.team.session" })) as never,
			refuseImpersonation: () => null,
			ambient,
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
		const target = { kind: "domain", domainId: "other" } as never;
		const file = path.join(dir, "migration-epoch");
		fs.writeFileSync(file, "8\n");
		useMigrationEpochFile(dir);
		invalidate();

		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: 8 });
		expect(
			pending.enqueue({
				deliveryId: "fenced",
				team: "team",
				channelJobId: "job",
				from: "from",
				body: "body",
				enqueuedAt: 1,
			} as never),
		).toBe("migrating");
		expect(ops.markInFlight("conversation", "fenced")).toBeNull();
		expect(anchors.report("owner", "team", { epoch: 1, seq: 1, at: 1 })).toBe(false);
		expect(shares.share("session", target)).toBe(false);
		expect(shares.unshare("session", target)).toBe("fenced");
		expect(push.deliverToOwner({ entry: { kind: "notice" } as never, dedupeKey: "fenced" })).toBe(MIGRATING);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({
			ok: false,
			error: "migrating",
		});

		fs.rmSync(file);
		invalidate();
		expect(
			pending.enqueue({
				deliveryId: "live",
				team: "team",
				channelJobId: "job",
				from: "from",
				body: "body",
				enqueuedAt: 1,
			} as never),
		).toBe("enqueued");
		expect(ops.markInFlight("conversation", "live")).toEqual(expect.any(Number));
		expect(anchors.report("owner", "team", { epoch: 1, seq: 1, at: 1 })).toBe(true);
		expect(shares.share("session", target)).toBe(true);
		expect(shares.all()).toEqual([expect.objectContaining({ sessionTarget: "session" })]);
		expect(push.deliverToOwner({ entry: { kind: "notice" } as never, dedupeKey: "live" })).toBe(true);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({ ok: true });
	});
});
