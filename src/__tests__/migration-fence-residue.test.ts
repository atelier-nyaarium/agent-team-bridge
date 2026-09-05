// Writer-local fence coverage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import { processAmbient } from "../shared/ambient.js";
import type { DurableStore } from "../shared/durable-store.js";
import {
	MIGRATING,
	readGatewayMigrationWindow,
	setMigrationEpoch,
	useMigrationEpochFile,
} from "../shared/migration-fence.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const delivery = (deliveryId: string) => ({
	deliveryId,
	team: "team",
	body: "body",
	enqueuedAt: 0,
	from: "from",
	channelJobId: "job",
});

const STORE_FILES = [
	"src/gateway/console/durableOpStore.ts",
	"src/gateway/federation/crossDomainShareState.ts",
	"src/shared/durable-outbox.ts",
	"src/shared/pending-delivery-store.ts",
];

function writers(): Array<{ file: string; symbol: string }> {
	const found: Array<{ file: string; symbol: string }> = [];
	for (const file of STORE_FILES) {
		const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		const methods = [
			...source.matchAll(
				/^\s*(?:(?:export|private|public|protected|static|async|function)\s+)*(?!(?:if|for|while|switch|catch)\s*\()(\w+)\s*\([^)]*\)[^{]*\{/gm,
			),
		].map((match, index, all) => ({
			symbol: match[1],
			body: source.slice(match.index, all[index + 1]?.index ?? source.length),
		}));
		const helpers = new Set(
			methods
				.filter(
					({ body, symbol }) =>
						symbol !== "persist" && (body.includes("this.persist(") || body.includes("fenced()")),
				)
				.map(({ symbol }) => symbol),
		);
		helpers.delete("write");
		let changed = true;
		while (changed) {
			changed = false;
			for (const method of methods) {
				if (helpers.has(method.symbol)) continue;
				if ([...helpers].some((helper) => method.body.includes(`this.${helper}(`))) {
					helpers.add(method.symbol);
					changed = true;
				}
			}
		}
		for (const symbol of helpers) found.push({ file, symbol });
	}
	return found;
}

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
	it("reads no gateway fence as an open window", () => {
		const dir = tempDir();
		useMigrationEpochFile(dir);
		expect(readGatewayMigrationWindow()).toEqual({ fenced: false, epoch: null });
	});

	it("reads a gateway fence epoch", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "migration-epoch"), "12\n");
		useMigrationEpochFile(dir);
		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: 12 });
	});

	it("fails closed for an unreadable gateway fence", () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, "migration-epoch"));
		useMigrationEpochFile(dir);
		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: null });
	});

	it("every named writer calls the guard in its own body", () => {
		const floor = [
			{ file: "src/gateway/consolePushOps.ts", symbol: "deliverToOwner" },
			{ file: "src/shared/pending-delivery-store.ts", symbol: "enqueue" },
			{ file: "src/gateway/readAnchors.ts", symbol: "report" },
			{ file: "src/gateway/federation/gatewayRelay.ts", symbol: "handleOp" },
		];
		const derived = writers();
		expect(
			floor.every(({ file, symbol }) => {
				const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
				const start = source.search(
					new RegExp(
						`^\\s*(?:(?:export|private|public|protected|static|async|function)\\s+)*${symbol}\\s*\\(`,
						"m",
					),
				);
				return start >= 0 && source.slice(start, start + 900).includes("fenced()");
			}),
		).toBe(true);
		const missing = [...floor, ...derived].filter(({ file, symbol }) => {
			if (!derived.some((candidate) => candidate.file === file && candidate.symbol === symbol)) return false;
			const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
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

		expect(source).not.toContain("fenced()");
	});

	it("a held delivery refuses under the fence", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const delivery = { deliveryId: "d1", team: "t", queuedAt: 0 } as never;

		expect(store.enqueue(delivery)).toBe("enqueued");
		setMigrationEpoch(7);

		expect(store.enqueue({ ...(delivery as object), deliveryId: "d2" } as never)).toBe("migrating");
	});

	it("pending delivery writers refuse and write after removal", () => {
		let now = 2_000;
		const store = new PendingDeliveryStore(undefined, { now: () => now }, 100);
		store.enqueue({ ...(delivery("d1") as object), enqueuedAt: 1_000 } as never);
		setMigrationEpoch(7);
		expect(store.acknowledge("d1")).toBe(MIGRATING);
		expect(store.failTeam("team")).toBe(MIGRATING);
		expect(store.sweep()).toBe(MIGRATING);
		setMigrationEpoch(null);
		expect(store.acknowledge("d1")).toBe(true);
		store.enqueue(delivery("d2"));
		expect(store.failTeam("team")).toHaveLength(1);
		store.enqueue({ ...(delivery("d3") as object), enqueuedAt: 1_000 } as never);
		expect(store.sweep()).toHaveLength(1);
		now = 3_000;
	});

	it("a read anchor never advances under the fence", () => {
		const anchors = new ReadAnchors(new PlaneRegistry(processAmbient()), undefined);

		expect(anchors.report("alice", "team", { epoch: 1, seq: 1, at: 1 })).toBe(true);
		setMigrationEpoch(7);

		expect(anchors.report("alice", "team", { epoch: 1, seq: 2, at: 2 })).toBe(false);
	});

	it("taking ownership of an op key answers null under the fence", () => {
		const store = new DurableOpStore(fakeDurable(), processAmbient());

		expect(store.markInFlight("conv", "op-1")).toEqual(expect.any(Number));
		setMigrationEpoch(7);

		expect(store.markInFlight("conv", "op-2")).toBeNull();
	});

	it("the settle drops in-flight records and keeps completed ones", () => {
		const store = new DurableOpStore(fakeDurable(), processAmbient());
		store.markInFlight("conv", "done");
		store.markComplete("conv", "done", { delivered: true } as never);
		store.markInFlight("conv", "caught");

		expect(store.failInFlight()).toBe(1);

		expect(store.get("conv", "done")).toMatchObject({ state: "complete" });
		expect(store.get("conv", "caught")).toBeUndefined();
	});

	it("the share sweep removes nothing under the fence", () => {
		const state = new CrossDomainShareState(tempDir(), undefined, processAmbient());
		setMigrationEpoch(7);

		expect(state.sweep(Date.now(), 0, () => false)).toBe(0);
	});

	it("a share is neither taken nor withdrawn under the fence", () => {
		const state = new CrossDomainShareState(tempDir(), undefined, processAmbient());
		const target = { kind: "domain", domainId: "beta" } as never;
		state.share("alpha.gw.spawn.session", target);
		setMigrationEpoch(7);

		state.share("alpha.gw.other.session", target);

		expect(state.unshare("alpha.gw.spawn.session", target)).toBe(false);
		setMigrationEpoch(null);
		expect(state.unshare("alpha.gw.spawn.session", target)).toBe(true);
		expect(state.unshare("alpha.gw.other.session", target)).toBe(false);
	});
});
