import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { createCursorService } from "../federation-server/migration/cursorService.js";
import { createLeaseService, readRouterMigrationWindow } from "../federation-server/migration/leaseService.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { generateIdentity } from "../shared/crypto.js";
import { translateCursor } from "../shared/migration-cursor.js";

const roots: string[] = [];

function make(epoch = 7) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-"));
	roots.push(dataDir);
	const owner = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => (domainId === "alpha" ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => 100 },
	});
	return {
		registry,
		service: createLeaseService({
			registry,
			migrationWindow: () => ({ fenced: epoch !== 0, epoch: epoch || null }),
		}),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration lease service", () => {
	it("reads a Router file epoch", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-file-"));
		roots.push(dir);
		fs.writeFileSync(path.join(dir, "migration-epoch"), "9\n");
		const previousDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		process.env.ROUTER_MIGRATION_EPOCH = "3";
		try {
			expect(readRouterMigrationWindow()).toEqual({ fenced: true, epoch: 9 });
		} finally {
			if (previousDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
		}
	});

	it("uses the Router variable only without a file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-env-"));
		roots.push(dir);
		const previousDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		process.env.ROUTER_MIGRATION_EPOCH = "3";
		try {
			expect(readRouterMigrationWindow()).toEqual({ fenced: true, epoch: 3 });
		} finally {
			if (previousDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
		}
	});

	it("reads no Router fence as an open window", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-none-"));
		roots.push(dir);
		const previousDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		delete process.env.ROUTER_MIGRATION_EPOCH;
		try {
			expect(readRouterMigrationWindow()).toEqual({ fenced: false, epoch: null });
		} finally {
			if (previousDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
		}
	});

	it("fails closed for an unreadable Router fence", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-bad-"));
		roots.push(dir);
		fs.mkdirSync(path.join(dir, "migration-epoch"));
		const previousDir = process.env.DATA_DIR;
		const previousEpoch = process.env.ROUTER_MIGRATION_EPOCH;
		process.env.DATA_DIR = dir;
		process.env.ROUTER_MIGRATION_EPOCH = "3";
		try {
			expect(readRouterMigrationWindow()).toEqual({ fenced: true, epoch: null });
		} finally {
			if (previousDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDir;
			if (previousEpoch === undefined) delete process.env.ROUTER_MIGRATION_EPOCH;
			else process.env.ROUTER_MIGRATION_EPOCH = previousEpoch;
		}
	});
	it("holds authority until every active gateway completes", () => {
		const { registry, service } = make();
		service.put("alpha", "hosta", "active");
		service.put("alpha", "hostb", "active");

		expect(service.ready("alpha")).toBe(false);

		service.complete("alpha", "hosta");
		expect(service.ready("alpha")).toBe(false);

		service.complete("alpha", "hostb");
		expect(service.ready("alpha")).toBe(true);
		registry.close();
	});

	it("lets an offline gateway pass authority while still fencing its writes", () => {
		const { registry, service } = make();
		service.put("alpha", "hosta", "active");
		service.complete("alpha", "hosta");
		service.put("alpha", "sleeper", "offline");

		expect(service.ready("alpha")).toBe(true);
		expect(service.fenced("alpha", "sleeper")).toBe(true);
		expect(service.fenced("alpha", "hosta")).toBe(false);
		registry.close();
	});

	it("fences a gateway it has no lease for", () => {
		const { registry, service } = make();

		expect(service.fenced("alpha", "stranger")).toBe(true);
		registry.close();
	});

	it("fences nobody outside a migration window", () => {
		const { registry, service } = make(0);

		expect(service.fenced("alpha", "stranger")).toBe(false);
		registry.close();
	});

	it("fails closed when the Router fence epoch is unknown", () => {
		const { registry, service } = make(Number.NaN);
		expect(service.ready("alpha")).toBe(false);
		expect(service.fenced("alpha", "hosta")).toBe(true);
		registry.close();
	});

	it("answers a cursor translation from the stored map, the same way every time", () => {
		const { registry } = make();
		const cursors = createCursorService({ registry, migrationEpoch: () => 7 });
		const address = "owner:alpha/key";
		registry.for("alpha").put("inbox.address", address, null, {
			clear: { cursorMap: [{ oldEpoch: 4, oldSeq: 9, epoch: 7, seq: 2 }] },
		});

		const first = translateCursor({ epoch: 4, seq: 9 }, 7, cursors.mapFor("alpha", address));

		expect(first).toEqual({ kind: "translated", cursor: { epoch: 7, seq: 2 } });
		expect(translateCursor({ epoch: 4, seq: 9 }, 7, cursors.mapFor("alpha", address))).toEqual(first);
		expect(translateCursor({ epoch: 4, seq: 5 }, 7, cursors.mapFor("alpha", address))).toEqual({
			kind: "unmapped",
		});
		registry.close();
	});

	it("survives a reopen, since a lease outlives the process that took it", () => {
		const { registry, service } = make();
		service.put("alpha", "hosta", "active");
		service.complete("alpha", "hosta");

		expect(service.read("alpha", "hosta")).toMatchObject({ state: "active", completedEpoch: 7 });
		registry.close();
	});
});
