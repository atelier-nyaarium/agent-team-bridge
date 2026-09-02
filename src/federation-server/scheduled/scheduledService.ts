import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import type { InboxAddress, OpKey, OpResultEnvelope, OwnerOp } from "../../shared/schemasInbox.js";
import {
	ScheduleCancelValueSchema,
	type ScheduledRecord,
	ScheduledRecordSchema,
	type ScheduledTarget,
	ScheduleListValueSchema,
	ScheduleSendValueSchema,
} from "../../shared/schemasScheduled.js";
import { isComposite } from "../../shared/session-id.js";
import type { InboxService } from "../inbox/inboxService.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

type TimerHandle = unknown;
export interface ScheduledScheduler {
	set(ms: number, fn: () => void): TimerHandle;
	clear(handle: TimerHandle): void;
}
export interface ScheduledDeps {
	registry: OwnerStoreRegistry;
	inbox: Pick<InboxService, "appendRouterRow">;
	appendScheduledMessage: (
		domainId: string,
		address: InboxAddress,
		opKey: OpKey,
		body: ContentEnvelope,
		contentRefs: string[],
	) => OpResultEnvelope & { seq?: number };
	referenceHeld: {
		has(domainId: string, blobId: string): boolean;
		hold(domainId: string, blobId: string, ref: { kind: "scheduled" | "row"; id: string }): void;
		release(domainId: string, blobId: string, ref: { kind: "scheduled"; id: string }): void;
	};
	scheduler: ScheduledScheduler;
	now: () => number;
}

const RETRY_MS = 60_000;
const TERMINAL = new Set(["fired", "cancelled", "error"]);
const recordId = (target: ScheduledTarget): string => `${target.domainId}/${target.gatewayId}/${target.sessionId}`;
const addressOf = (target: ScheduledTarget): InboxAddress => ({ kind: "session", ...target });
/** The send and result rows use adjacent ledger keys. */
const messageKey = (record: { sender: { conversationId: string }; opId: string }): OpKey => ({
	conversationId: record.sender.conversationId,
	opId: record.opId,
});
const resultKey = (record: { sender: { conversationId: string }; opId: string }, outcome: string): OpKey => ({
	conversationId: record.sender.conversationId,
	opId: `${record.opId}.${outcome}`,
});

export function createScheduledService(deps: ScheduledDeps) {
	const timers = new Map<string, TimerHandle>();
	const envelope = (
		op: { conversationId: string; opId: string },
		outcome: OpResultEnvelope["outcome"],
		extra = {},
	) => ({
		opKey: { conversationId: op.conversationId, opId: op.opId },
		outcome,
		...extra,
	});
	const ownerAddress = (domainId: string): InboxAddress => ({
		kind: "owner",
		domainId,
		ownerSignPub: deps.registry.ownerKey(domainId).ownerSignPub,
	});
	const resultRow = (
		domainId: string,
		record: ScheduledRecord,
		outcome: "pending" | "sent" | "failed",
		seq?: number,
	) =>
		deps.inbox.appendRouterRow({
			address: ownerAddress(domainId),
			kind: "scheduled_result",
			opKey: resultKey(record, outcome),
			body: { opId: record.opId, outcome, ...(seq === undefined ? {} : { seq }), body: record.body },
			contentRefs: record.files,
		});
	const scheduledRef = (target: ScheduledTarget) => ({ kind: "scheduled" as const, id: recordId(target) });
	const releaseFiles = (domainId: string, record: { target: ScheduledTarget; files: string[] }) => {
		for (const blobId of record.files) deps.referenceHeld.release(domainId, blobId, scheduledRef(record.target));
	};
	const timerKey = (domainId: string, target: ScheduledTarget) => `${domainId}/${recordId(target)}`;
	const clearTimer = (domainId: string, target: ScheduledTarget) => {
		const key = timerKey(domainId, target);
		const old = timers.get(key);
		if (old !== undefined) deps.scheduler.clear(old);
		timers.delete(key);
	};
	const scheduleTimer = (domainId: string, target: ScheduledTarget, fireAt: number) => {
		clearTimer(domainId, target);
		const key = timerKey(domainId, target);
		const handle = deps.scheduler.set(Math.max(0, fireAt - deps.now()), () => {
			timers.delete(key);
			void fire(domainId, target);
		});
		timers.set(key, handle);
	};

	function schedule(
		domainId: string,
		sender: { conversationId: string; device: string; opId: string },
		value: unknown,
	) {
		const parsed = ScheduleSendValueSchema.safeParse(value);
		if (!parsed.success) return envelope(sender, "refused", { reason: "malformed" });
		const input = parsed.data;
		if (!isComposite(input.target.sessionId)) return envelope(sender, "refused", { reason: "spawn point" });
		if (input.target.domainId !== domainId) return envelope(sender, "refused", { reason: "domain" });
		for (const file of input.files)
			if (!deps.referenceHeld.has(domainId, file)) return envelope(sender, "refused", { reason: "file" });
		const store = deps.registry.for(domainId);
		const id = recordId(input.target);
		const current = store.get("scheduled", id);
		const expected = current ? (input.expectedVersion ?? null) : null;
		if (current ? expected !== current.version : input.expectedVersion !== undefined)
			return envelope(sender, "conflict", { version: current?.version });
		const previous = current
			? ScheduledRecordSchema.safeParse({ ...current.clear, version: current.version })
			: null;
		const record = {
			target: input.target,
			fireAt: input.fireAt,
			createdAt: deps.now(),
			opId: input.opId,
			sender: { conversationId: sender.conversationId, device: sender.device },
			files: input.files,
			body: input.body,
			state: "armed",
			attempts: 0,
		};
		const write = store.put("scheduled", id, current ? expected : null, { clear: record });
		if (write.kind !== "ok")
			return envelope(sender, write.kind === "conflict" ? "conflict" : "durability_uncertain");
		// A membership diff, never release-then-hold. Both halves name the same reference, so releasing
		// a kept file takes its last reference and deletes the bytes. Holding first does not help:
		// hold is idempotent, so the release still finds one reference and zeroes it.
		if (previous?.success && previous.data.state === "armed") {
			const kept = new Set(input.files);
			releaseFiles(domainId, {
				...previous.data,
				files: previous.data.files.filter((blobId) => !kept.has(blobId)),
			});
		}
		for (const blobId of input.files) deps.referenceHeld.hold(domainId, blobId, scheduledRef(input.target));
		scheduleTimer(domainId, input.target, input.fireAt);
		const pending = resultRow(domainId, { ...record, version: write.version } as ScheduledRecord, "pending");
		if (pending.outcome !== "accepted") return envelope(sender, "durability_uncertain");
		return envelope(sender, "accepted", { version: write.version });
	}

	function cancel(domainId: string, target: ScheduledTarget, expectedVersion: number) {
		const store = deps.registry.for(domainId);
		const current = store.get("scheduled", recordId(target));
		if (!current || current.version !== expectedVersion)
			return { outcome: "refused", reason: "conflict", version: current?.version };
		if (TERMINAL.has(String(current.clear.state))) return { outcome: "refused", reason: "settled" };
		const record = ScheduledRecordSchema.parse({
			...current.clear,
			state: "cancelled",
			version: current.version + 1,
		});
		const write = store.put("scheduled", current.id, expectedVersion, { clear: record });
		if (write.kind !== "ok") return { outcome: "refused", reason: "conflict" };
		clearTimer(domainId, target);
		releaseFiles(domainId, record);
		return { outcome: "accepted", version: write.version };
	}

	function list(domainId: string): ScheduledRecord[] {
		return deps.registry
			.for(domainId)
			.list("scheduled")
			.map((record) => ScheduledRecordSchema.parse({ ...record.clear, version: record.version }));
	}

	/** Retry store failures; silently abort lost races. */
	const retryLater = (domainId: string, target: ScheduledTarget) =>
		scheduleTimer(domainId, target, deps.now() + RETRY_MS);

	async function fire(domainId: string, target: ScheduledTarget): Promise<unknown> {
		const store = deps.registry.for(domainId);
		const current = store.get("scheduled", recordId(target));
		if (!current) return { outcome: "gone" };
		const record = ScheduledRecordSchema.parse({ ...current.clear, version: current.version });
		if (TERMINAL.has(record.state)) return { outcome: "ignored" };
		const firing = store.put("scheduled", current.id, current.version, { clear: { ...record, state: "firing" } });
		if (firing.kind === "conflict") return { outcome: "conflict" };
		if (firing.kind !== "ok") {
			retryLater(domainId, target);
			return { outcome: firing.kind };
		}
		const sent = deps.appendScheduledMessage(
			domainId,
			addressOf(target),
			messageKey(record),
			record.body,
			record.files,
		);
		if (sent.outcome === "accepted") {
			// The row now holds the files; release the schedule hold.
			if (sent.seq !== undefined)
				for (const blobId of record.files)
					deps.referenceHeld.hold(domainId, blobId, { kind: "row", id: `${recordId(target)}:${sent.seq}` });
			releaseFiles(domainId, record);
			const done = store.put("scheduled", current.id, firing.version, {
				clear: { ...record, state: "fired", attempts: record.attempts + 1 },
			});
			if (done.kind === "ok") resultRow(domainId, record, "sent", sent.seq);
			else retryLater(domainId, target);
			return sent;
		}
		const attempts = record.attempts + 1;
		if (attempts < 2) {
			const retry = store.put("scheduled", current.id, firing.version, {
				clear: { ...record, state: "armed", attempts },
			});
			if (retry.kind === "ok" || retry.kind !== "conflict") retryLater(domainId, target);
			return sent;
		}
		const failed = store.put("scheduled", current.id, firing.version, {
			clear: { ...record, state: "error", attempts },
		});
		if (failed.kind !== "ok" && failed.kind !== "conflict") {
			retryLater(domainId, target);
			return sent;
		}
		releaseFiles(domainId, record);
		resultRow(domainId, record, "failed");
		return sent;
	}

	function rearm(domainId: string): void {
		for (const record of list(domainId)) {
			if (record.state === "firing") {
				const store = deps.registry.for(domainId);
				store.put("scheduled", recordId(record.target), record.version, {
					clear: { ...record, state: "armed" },
				});
			}
			if (record.state === "armed" || record.state === "firing")
				scheduleTimer(domainId, record.target, record.fireAt);
		}
	}

	return {
		schedule,
		cancel,
		list,
		fire,
		rearm,
		register(hooks: OwnerServiceHooks) {
			hooks.ownerOp("schedule_send", (op: OwnerOp, value) =>
				schedule(op.domainId, { conversationId: op.conversationId, device: op.device, opId: op.opId }, value),
			);
			hooks.ownerOp("schedule_cancel", (op, value) => {
				const parsed = ScheduleCancelValueSchema.safeParse(value);
				return parsed.success
					? cancel(op.domainId, parsed.data.target, parsed.data.expectedVersion)
					: envelope(op, "refused", { reason: "malformed" });
			});
			hooks.ownerOp("schedule_list", (op, value) =>
				ScheduleListValueSchema.safeParse(value).success
					? list(op.domainId)
					: envelope(op, "refused", { reason: "malformed" }),
			);
		},
	};
}
