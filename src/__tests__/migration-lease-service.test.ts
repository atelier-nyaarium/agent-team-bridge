import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { createCursorService } from "../federation-server/migration/cursorService.js";
import { createLeaseService } from "../federation-server/migration/leaseService.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { generateIdentity } from "../shared/crypto.js";
import { translateCursor } from "../shared/migration-cursor.js";

const roots: string[] = [];

function make(migrationEpoch = 7) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-lease-"));
	roots.push(dataDir);
	const owner = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => (domainId === "alpha" ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => 100,
	});
	return { registry, service: createLeaseService({ registry, migrationEpoch: () => migrationEpoch }) };
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration lease service", () => {
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

	// One asleep machine cannot hold the fleet, and is fenced on reconnect instead.
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

	// It cannot have completed a migration nobody recorded.
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

	// Repeatable by construction: the map is kept for the whole window, so a phone that dies between
	// hearing the answer and committing it asks again and gets the same one.
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
