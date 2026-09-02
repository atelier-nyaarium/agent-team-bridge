import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { createScheduledService, type ScheduledDeps } from "../federation-server/scheduled/scheduledService.js";
import { generateIdentity } from "../shared/crypto.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import type { ScheduledTarget } from "../shared/schemasScheduled.js";

const roots: string[] = [];
const body: ContentEnvelope = {
	v: 1,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.alloc(16).toString("base64"),
};
const target: ScheduledTarget = { domainId: "domain-a", gatewayId: "gateway-a", sessionId: "spawn.session" };

function make(options: { appendOutcome?: "accepted" | "refused"; held?: boolean } = {}) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-service-"));
	roots.push(dataDir);
	const owner = generateIdentity();
	let now = 100;
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (domainId) => (domainId === "domain-a" ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		now: () => now,
	});
	const timers = new Map<number, () => void>();
	const timerDelays = new Map<number, number>();
	let nextTimer = 1;
	const messages: unknown[] = [];
	const rows: unknown[] = [];
	const held: unknown[] = [];
	const released: unknown[] = [];
	const deps: ScheduledDeps = {
		registry,
		inbox: {
			appendRouterRow: (input) => {
				rows.push(input);
				return { opKey: input.opKey, outcome: "accepted", seq: 1 };
			},
		},
		appendScheduledMessage: (_domainId, _address, opKey, messageBody, contentRefs) => {
			messages.push({ opKey, body: messageBody, contentRefs });
			return {
				opKey: { conversationId: "c", opId: "scheduled" },
				outcome: options.appendOutcome ?? "accepted",
				seq: 7,
			};
		},
		referenceHeld: {
			has: () => options.held ?? true,
			hold: (_domainId, blobId, ref) => held.push({ blobId, ref }),
			release: (_domainId, blobId, ref) => released.push({ blobId, ref }),
		},
		scheduler: {
			set: (ms, fn) => {
				const handle = nextTimer++;
				timerDelays.set(handle, ms);
				timers.set(handle, fn);
				return handle;
			},
			clear: (handle) => {
				timers.delete(handle as number);
				timerDelays.delete(handle as number);
			},
		},
		now: () => now,
	};
	return {
		service: createScheduledService(deps),
		registry,
		timers,
		setNow: (value: number) => (now = value),
		messages,
		rows,
		held,
		released,
		timerDelays,
		deps,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("scheduled service", () => {
	it("arms one record, writes pending state, and replaces only with the current version", () => {
		const { service, registry, rows, held, released, timers, timerDelays } = make();
		const first = service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone-a", opId: "op-1" },
			{
				kind: "schedule_send",
				target,
				fireAt: 200,
				opId: "op-1",
				files: [],
				body,
			},
		);
		expect(timers).toHaveLength(1);
		expect(timerDelays.get(1)).toBe(100);
		const second = service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone-b", opId: "op-2" },
			{
				kind: "schedule_send",
				target,
				fireAt: 300,
				opId: "op-2",
				files: [],
				body,
			},
		);
		const replacement = service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone-b", opId: "op-2" },
			{
				kind: "schedule_send",
				target,
				fireAt: 300,
				opId: "op-2",
				files: [],
				body,
				expectedVersion: 1,
			},
		);
		expect(first).toMatchObject({ outcome: "accepted", version: 1 });
		expect(second).toMatchObject({ outcome: "conflict" });
		expect(replacement).toMatchObject({ outcome: "accepted", version: 2 });
		expect(service.list("domain-a")).toHaveLength(1);
		expect(timers).toHaveLength(1);
		expect(timerDelays.get(2)).toBe(200);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ kind: "scheduled_result", body: { opId: "op-1", outcome: "pending", body } });
		expect(rows[1]).toMatchObject({ kind: "scheduled_result", body: { opId: "op-2", outcome: "pending", body } });
		expect(rows.map((row) => (row as { opKey: { opId: string } }).opKey.opId)).toEqual([
			"op-1.pending",
			"op-2.pending",
		]);
		expect(held).toEqual([]);
		expect(released).toEqual([]);
		registry.close();
	});

	it("holds files on schedule and releases the previous hold on replace", () => {
		const { service, registry, held, released } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["blob-1", "blob-2"], body },
		);
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-2" },
			{
				kind: "schedule_send",
				target,
				fireAt: 300,
				opId: "op-2",
				files: ["blob-3"],
				body,
				expectedVersion: 1,
			},
		);
		expect(held).toEqual([
			{ blobId: "blob-1", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
			{ blobId: "blob-2", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
			{ blobId: "blob-3", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		expect(released).toEqual([
			{ blobId: "blob-1", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
			{ blobId: "blob-2", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		registry.close();
	});

	// Shared file references survive edits.
	it("keeps a file carried across an edit held", () => {
		const { service, registry, released } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["kept", "dropped"], body },
		);
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-2" },
			{
				kind: "schedule_send",
				target,
				fireAt: 300,
				opId: "op-2",
				files: ["kept", "added"],
				body,
				expectedVersion: 1,
			},
		);

		expect(released).toEqual([
			{ blobId: "dropped", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		registry.close();
	});

	// Fire and cancel release only the CURRENT set, so an edit landing mid-fire is the last chance to
	// let a dropped file go.
	it("releases dropped files when the edit lands on a firing record", () => {
		const { service, registry, released } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["kept", "dropped"], body },
		);
		const store = registry.for("domain-a");
		const armed = store.get("scheduled", "domain-a/gateway-a/spawn.session")!;
		store.put("scheduled", armed.id, armed.version, { clear: { ...armed.clear, state: "firing" } });

		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-3" },
			{
				kind: "schedule_send",
				target,
				fireAt: 400,
				opId: "op-3",
				files: ["kept"],
				body,
				expectedVersion: 2,
			},
		);

		expect(released).toEqual([
			{ blobId: "dropped", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		registry.close();
	});

	it("refuses stale cancellation and cancels the current record with all file references released", () => {
		const { service, registry, released, timers } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["blob-1", "blob-2"], body },
		);
		expect(service.cancel("domain-a", target, 2)).toMatchObject({ outcome: "refused" });
		expect(service.cancel("domain-a", target, 1)).toMatchObject({ outcome: "accepted", version: 2 });
		expect(service.list("domain-a")[0]?.state).toBe("cancelled");
		expect(timers).toHaveLength(0);
		expect(released).toEqual([
			{ blobId: "blob-1", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
			{ blobId: "blob-2", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		registry.close();
	});

	it("fires once with the sealed body and content references", async () => {
		const { service, registry, messages, rows } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{
				kind: "schedule_send",
				target,
				fireAt: 200,
				opId: "op-1",
				files: ["blob-1"],
				body,
			},
		);
		await service.fire("domain-a", target);
		await service.fire("domain-a", target);
		expect(messages).toEqual([
			{
				opKey: { conversationId: "conversation", opId: "op-1" },
				body,
				contentRefs: ["blob-1"],
			},
		]);
		expect(service.list("domain-a")[0]?.state).toBe("fired");
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ body: { opId: "op-1", outcome: "sent", seq: 7, body } });
		registry.close();
	});

	it("holds each file for the message row and releases the scheduled hold on fire", async () => {
		const { service, registry, held, released } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["blob-1"], body },
		);
		await service.fire("domain-a", target);
		expect(held.at(-1)).toEqual({
			blobId: "blob-1",
			ref: { kind: "row", id: "domain-a/gateway-a/spawn.session:7" },
		});
		expect(released).toEqual([
			{ blobId: "blob-1", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		registry.close();
	});

	it("uses distinct result row opIds and the bare message opId", async () => {
		const { service, registry, messages, rows } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: [], body },
		);
		await service.fire("domain-a", target);
		expect((messages[0] as { opKey: { opId: string } }).opKey.opId).toBe("op-1");
		expect(rows.map((row) => (row as { opKey: { opId: string } }).opKey.opId)).toEqual([
			"op-1.pending",
			"op-1.sent",
		]);
		registry.close();
	});

	it("does not append for cancelled or already fired records", async () => {
		const { service, registry, messages } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: [], body },
		);
		service.cancel("domain-a", target, 1);
		expect(await service.fire("domain-a", target)).toMatchObject({ outcome: "ignored" });
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-2" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-2", files: [], body, expectedVersion: 2 },
		);
		await service.fire("domain-a", target);
		expect(await service.fire("domain-a", target)).toMatchObject({ outcome: "ignored" });
		expect(messages).toHaveLength(1);
		registry.close();
	});

	it("retries a refused append once, then errors and releases files", async () => {
		const { service, registry, rows, released, timers, timerDelays } = make({ appendOutcome: "refused" });
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: ["blob-1"], body },
		);
		await service.fire("domain-a", target);
		expect(service.list("domain-a")[0]).toMatchObject({ state: "armed", attempts: 1 });
		expect(timers).toHaveLength(1);
		expect(timerDelays.get(2)).toBe(60_000);
		await service.fire("domain-a", target);
		expect(service.list("domain-a")[0]).toMatchObject({ state: "error", attempts: 2 });
		expect(released).toEqual([
			{ blobId: "blob-1", ref: { kind: "scheduled", id: "domain-a/gateway-a/spawn.session" } },
		]);
		expect(rows.at(-1)).toMatchObject({ body: { opId: "op-1", outcome: "failed", body } });
		registry.close();
	});

	it("refuses cancellation of a settled record", async () => {
		const { service, registry } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: [], body },
		);
		await service.fire("domain-a", target);
		expect(service.cancel("domain-a", target, 3)).toMatchObject({ outcome: "refused", reason: "settled" });
		registry.close();
	});

	it("rearms after a durability failure on the firing put", async () => {
		const { service, registry, timers, timerDelays } = make();
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 200, opId: "op-1", files: [], body },
		);
		const put = vi.spyOn(registry.for("domain-a"), "put").mockReturnValueOnce({
			kind: "durability_failure",
			reason: "disk",
		});
		expect(await service.fire("domain-a", target)).toMatchObject({ outcome: "durability_failure" });
		expect(service.list("domain-a")[0]?.state).toBe("armed");
		expect(timers).toHaveLength(1);
		expect(timerDelays.get(2)).toBe(60_000);
		put.mockRestore();
		registry.close();
	});

	it("rearms all armed records and schedules past-due records immediately", async () => {
		const { service, registry, timers, timerDelays, deps } = make();
		const other = { ...target, gatewayId: "gateway-b", sessionId: "other.session" };
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-1" },
			{ kind: "schedule_send", target, fireAt: 50, opId: "op-1", files: [], body },
		);
		service.schedule(
			"domain-a",
			{ conversationId: "conversation", device: "phone", opId: "op-2" },
			{ kind: "schedule_send", target: other, fireAt: 200, opId: "op-2", files: [], body },
		);
		const fresh = createScheduledService(deps);
		fresh.rearm("domain-a");
		expect(timerDelays.get(3)).toBe(0);
		expect(timerDelays.get(4)).toBe(100);
		const due = timers.get(3);
		due?.();
		await Promise.resolve();
		expect(fresh.list("domain-a")[0]?.state).toBe("fired");
		registry.close();
	});

	it("refuses spawn points and unheld files, and isolates Domains", () => {
		const { service, registry } = make({ held: false });
		const spawn = { ...target, sessionId: "spawn" };
		expect(
			service.schedule(
				"domain-a",
				{ conversationId: "c", device: "d", opId: "o" },
				{
					kind: "schedule_send",
					target: spawn,
					fireAt: 200,
					opId: "o",
					files: [],
					body,
				},
			),
		).toMatchObject({ outcome: "refused" });
		expect(
			service.schedule(
				"domain-a",
				{ conversationId: "c", device: "d", opId: "file" },
				{ kind: "schedule_send", target, fireAt: 200, opId: "file", files: ["missing"], body },
			),
		).toMatchObject({ outcome: "refused" });
		expect(() => service.list("domain-b")).toThrow();
		registry.close();
	});

	it("keeps records in separate Domains", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-domains-"));
		roots.push(dataDir);
		const ownerA = generateIdentity();
		const ownerB = generateIdentity();
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (domainId) =>
				domainId === "domain-a" ? ownerA.sign.pub : domainId === "domain-b" ? ownerB.sign.pub : null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		});
		const service = createScheduledService({
			...make().deps,
			registry,
		});
		service.schedule(
			"domain-a",
			{ conversationId: "a", device: "d", opId: "a" },
			{
				kind: "schedule_send",
				target,
				fireAt: 200,
				opId: "a",
				files: [],
				body,
			},
		);
		service.schedule(
			"domain-b",
			{ conversationId: "b", device: "d", opId: "b" },
			{
				kind: "schedule_send",
				target: { ...target, domainId: "domain-b" },
				fireAt: 200,
				opId: "b",
				files: [],
				body,
			},
		);
		expect(service.list("domain-a")).toHaveLength(1);
		expect(service.list("domain-b")).toHaveLength(1);
		registry.close();
	});
});
