import { describe, expect, it, vi } from "vitest";
import { createShareAttestor } from "../gateway/router/shareAttestor.js";

describe("share attestor", () => {
	it("attests live targets and clears jobs that disappeared", () => {
		let shares = ["domain.gateway.team.session"];
		let jobs = ["job-1"];
		const send = vi.fn(async () => ({}));
		const attestor = createShareAttestor({
			shares: () => shares,
			liveJobIds: () => jobs,
			send,
			incarnation: () => 1,
			// The diff is what this case is about; pacing has its own.
			minGapMs: 0,
		});
		attestor.attest();
		expect(send).toHaveBeenCalledWith("share_job_live", expect.objectContaining({ jobIds: ["job-1"] }));
		jobs = [];
		attestor.attest();
		expect(send).toHaveBeenLastCalledWith("share_job_live", expect.objectContaining({ jobIds: [] }));
		shares = [];
		attestor.attest();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("coalesces a burst of changes into one attestation", async () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => ({}));
		const attestor = createShareAttestor({
			shares: () => ["domain.gateway.team.session"],
			liveJobIds: () => ["job-1"],
			send,
			incarnation: () => 1,
			minGapMs: 1_000,
		});

		for (let i = 0; i < 20; i++) attestor.attest();
		expect(send).toHaveBeenCalledTimes(1);

		for (let i = 0; i < 20; i++) attestor.attest();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).toHaveBeenCalledTimes(2);
		attestor.stop();
		vi.useRealTimers();
	});

	it("sends nothing while unregistered and supports interval control", () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => ({}));
		const attestor = createShareAttestor({
			shares: () => ["domain.gateway.team.session"],
			liveJobIds: () => ["job-1"],
			send,
			incarnation: () => null,
			intervalMs: 100,
		});
		attestor.start();
		vi.advanceTimersByTime(100);
		expect(send).not.toHaveBeenCalled();
		attestor.stop();
		vi.useRealTimers();
	});

	it("resends live jobs on each registered interval", () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => ({}));
		const attestor = createShareAttestor({
			shares: () => ["domain.gateway.team.session"],
			liveJobIds: () => ["job-1"],
			send,
			incarnation: () => 1,
			intervalMs: 100,
		});
		attestor.start();
		vi.advanceTimersByTime(200);
		expect(send).toHaveBeenCalledTimes(2);
		attestor.stop();
		vi.useRealTimers();
	});
});
