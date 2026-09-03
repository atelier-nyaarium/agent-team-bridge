import { describe, expect, it } from "vitest";
import { authorityReady, fenceOnReconnect, leaseKey, type MigrationLease } from "../shared/migration-lease.js";

const lease = (over: Partial<MigrationLease> = {}): MigrationLease => ({ state: "active", epoch: 7, ...over });

describe("migration lease", () => {
	it("keys a lease by Domain and gateway", () => {
		expect(leaseKey("alpha", "hosta")).not.toBe(leaseKey("alpha", "hostb"));
	});

	it("withholds authority until every active gateway has completed this epoch", () => {
		const done = lease({ completedEpoch: 7 });

		expect(authorityReady([done, lease()], 7)).toBe(false);
		expect(authorityReady([done, lease({ completedEpoch: 7 })], 7)).toBe(true);
	});

	it("does not let an offline gateway block authority", () => {
		expect(authorityReady([lease({ completedEpoch: 7 }), lease({ state: "offline" })], 7)).toBe(true);
	});

	it("ignores a gateway deliberately out of the fleet", () => {
		expect(authorityReady([lease({ state: "retired" }), lease({ state: "excluded" })], 7)).toBe(true);
	});

	it("counts completion per epoch rather than as a flag", () => {
		expect(authorityReady([lease({ completedEpoch: 6 })], 7)).toBe(false);
	});

	it("fences a reconnecting gateway until it has completed this epoch", () => {
		expect(fenceOnReconnect(lease(), 7)).toBe(true);
		expect(fenceOnReconnect(lease({ state: "offline" }), 7)).toBe(true);
		expect(fenceOnReconnect(lease({ completedEpoch: 7 }), 7)).toBe(false);
	});

	it("fences a gateway it has never heard of", () => {
		expect(fenceOnReconnect(undefined, 7)).toBe(true);
	});

	it("keeps a gateway out of the fleet fenced even once the epoch completes elsewhere", () => {
		expect(fenceOnReconnect(lease({ state: "retired", completedEpoch: 7 }), 7)).toBe(true);
		expect(fenceOnReconnect(lease({ state: "excluded", completedEpoch: 7 }), 7)).toBe(true);
	});
});
