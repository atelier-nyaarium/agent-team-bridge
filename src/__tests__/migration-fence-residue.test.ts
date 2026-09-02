// The fence is guarded AT THE WRITER, never at its callers, so a route added later that reaches a
// fenced writer is covered by construction. This test enumerates the WRITERS for that reason: a
// route-shaped test would pass while a new caller walked straight past the fence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import type { DurableStore } from "../shared/durable-store.js";
import { setMigrationEpoch } from "../shared/migration-fence.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every writer of migrated state S10 names, and the symbol the guard belongs in. */
const WRITERS: Array<{ file: string; symbol: string }> = [
	{ file: "src/gateway/consolePushOps.ts", symbol: "deliverToOwner" },
	{ file: "src/shared/pending-delivery-store.ts", symbol: "enqueue" },
	{ file: "src/gateway/boardStore.ts", symbol: "mutate" },
	{ file: "src/gateway/console/durableOpStore.ts", symbol: "markInFlight" },
	{ file: "src/gateway/readAnchors.ts", symbol: "report" },
	{ file: "src/gateway/federation/crossDomainShareState.ts", symbol: "share" },
	{ file: "src/gateway/federation/crossDomainShareState.ts", symbol: "unshare" },
	{ file: "src/gateway/federation/gatewayRelay.ts", symbol: "handleOp" },
];

const roots: string[] = [];

const fakeDurable = (): DurableStore => ({ load: () => null, save: () => {} }) as unknown as DurableStore;

const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-fence-"));
	roots.push(dir);
	return dir;
};

afterEach(() => {
	setMigrationEpoch(null);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration fence residue", () => {
	it("every named writer calls the guard in its own body", () => {
		const missing = WRITERS.filter(({ file, symbol }) => {
			const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			// From the declaration to the next one at the same depth, so a guard elsewhere in the file
			// cannot stand in for this writer's own.
			const start = source.search(
				new RegExp(
					`^\\s*(?:(?:export|private|public|protected|static|async|function)\\s+)*${symbol}\\s*\\(`,
					"m",
				),
			);
			if (start < 0) return true;
			return !source.slice(start, start + 900).includes("fenced()");
		});

		expect(missing).toEqual([]);
	});

	it("capabilityStore is deliberately unfenced", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/console/capabilityStore.ts"), "utf8");

		// Capabilities are not migrated: phones re-report on first hub connect. Fencing them would
		// refuse a report the migration never carries.
		expect(source).not.toContain("fenced()");
	});

	it("a held delivery refuses under the fence", () => {
		const store = new PendingDeliveryStore();
		const delivery = { deliveryId: "d1", team: "t", queuedAt: 0 } as never;

		expect(store.enqueue(delivery)).toBe("enqueued");
		setMigrationEpoch(7);

		expect(store.enqueue({ ...(delivery as object), deliveryId: "d2" } as never)).toBe("migrating");
	});

	it("a read anchor never advances under the fence", () => {
		const anchors = new ReadAnchors(new PlaneRegistry(), undefined);

		expect(anchors.report("alice", "team", { epoch: 1, seq: 1, at: 1 })).toBe(true);
		setMigrationEpoch(7);

		expect(anchors.report("alice", "team", { epoch: 1, seq: 2, at: 2 })).toBe(false);
	});

	it("taking ownership of an op key answers null under the fence", () => {
		const store = new DurableOpStore(fakeDurable());

		expect(store.markInFlight("conv", "op-1")).toEqual(expect.any(Number));
		setMigrationEpoch(7);

		expect(store.markInFlight("conv", "op-2")).toBeNull();
	});

	// The cut carries no op whose outcome nobody knows. A record is a marker rather than a request,
	// so an in-flight one cannot be re-run here and is dropped for the client to re-run instead.
	it("the settle drops in-flight records and keeps completed ones", () => {
		const store = new DurableOpStore(fakeDurable());
		store.markInFlight("conv", "done");
		store.markComplete("conv", "done", { delivered: true } as never);
		store.markInFlight("conv", "caught");

		expect(store.failInFlight()).toBe(1);

		expect(store.get("conv", "done")).toMatchObject({ state: "complete" });
		expect(store.get("conv", "caught")).toBeUndefined();
	});

	it("the share sweep removes nothing under the fence", () => {
		const state = new CrossDomainShareState(tempDir());
		setMigrationEpoch(7);

		expect(state.sweep(Date.now(), 0, () => false)).toBe(0);
	});

	it("a share is neither taken nor withdrawn under the fence", () => {
		const state = new CrossDomainShareState(tempDir());
		const target = { kind: "domain", domainId: "beta" } as never;
		state.share("alpha.gw.spawn.session", target);
		setMigrationEpoch(7);

		state.share("alpha.gw.other.session", target);

		expect(state.unshare("alpha.gw.spawn.session", target)).toBe(false);
		setMigrationEpoch(null);
		// The one taken before the fence survives; the one attempted under it was never taken.
		expect(state.unshare("alpha.gw.spawn.session", target)).toBe(true);
		expect(state.unshare("alpha.gw.other.session", target)).toBe(false);
	});
});
