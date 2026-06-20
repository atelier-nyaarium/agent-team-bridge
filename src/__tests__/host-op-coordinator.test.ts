import { describe, expect, it } from "vitest";
import { HostOpCoordinator } from "../gateway/hostOpCoordinator.js";

describe("HostOpCoordinator", () => {
	it("resolves a waiter when its reqId is settled", async () => {
		const coord = new HostOpCoordinator();
		const p = coord.wait("req-1", 1000);
		coord.settle("req-1", { ok: true, result: { ansi: "x", hash: "abc" } });
		await expect(p).resolves.toEqual({ ok: true, result: { ansi: "x", hash: "abc" } });
	});

	it("routes each reply to its own reqId (concurrent ops do not cross)", async () => {
		const coord = new HostOpCoordinator();
		const a = coord.wait("a", 1000);
		const b = coord.wait("b", 1000);
		coord.settle("b", { ok: true, result: "B" });
		coord.settle("a", { ok: true, result: "A" });
		await expect(a).resolves.toEqual({ ok: true, result: "A" });
		await expect(b).resolves.toEqual({ ok: true, result: "B" });
	});

	it("ignores a settle for an unknown or already-settled reqId", async () => {
		const coord = new HostOpCoordinator();
		const p = coord.wait("once", 1000);
		coord.settle("once", { ok: true, result: 1 });
		coord.settle("once", { ok: true, result: 2 }); // no throw, no effect
		coord.settle("never", { ok: true }); // unknown id, no throw
		await expect(p).resolves.toEqual({ ok: true, result: 1 });
	});

	it("resolves a clean timeout error rather than hanging", async () => {
		const coord = new HostOpCoordinator();
		await expect(coord.wait("slow", 10)).resolves.toEqual({ ok: false, error: "host op timed out" });
	});

	it("failAll resolves every in-flight op with an error (host disconnect)", async () => {
		const coord = new HostOpCoordinator();
		const a = coord.wait("a", 10_000);
		const b = coord.wait("b", 10_000);
		coord.failAll("host daemon disconnected");
		await expect(a).resolves.toEqual({ ok: false, error: "host daemon disconnected" });
		await expect(b).resolves.toEqual({ ok: false, error: "host daemon disconnected" });
	});
});
