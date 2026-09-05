import type { BlobReference } from "../../shared/blob-reference.js";
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
import { OP_OUTCOME_ACCEPTED } from "../../shared/wire-vocabulary.js";
import { foldWriteResult } from "../../shared/write-result.js";
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
		applyRefs(domainId: string, sets: readonly { ref: BlobReference; blobIds: readonly string[] }[]): void;
	};
	scheduler: ScheduledScheduler;
	now: () => number;
}

const RETRY_MS = 60_000;
const TERMINAL = new Set(["fired", "cancelled", "error"]);
const recordId = (target: ScheduledTarget): string => `${target.domainId}/${target.gatewayId}/${target.sessionId}`;
const addressOf = (target: ScheduledTarget): InboxAddress => ({ kind: "session", ...target });
/** Adjacent ledger keys. */
const messageKey = (record: { sender: { conversationId: string }; opId: string }): OpKey => ({
	conversationId: record.sender.conversationId,
	opId: record.opId,
});
const resultKey = (record: { sender: { conversationId: string }; opId: string }, outcome: string): OpKey => ({
	conversationId: record.sender.conversationId,
	opId: `${record.opId}.${outcome}`,
});
const writeVersion = (write: { kind: string; version?: number }, fallback: number): number => write.version ?? fallback;
const foldAppendResult = (result: OpResultEnvelope) =>
	foldWriteResult(
		result.outcome === OP_OUTCOME_ACCEPTED
			? { kind: "ok" }
			: result.outcome === "durability_uncertain"
				? { kind: "durability_uncertain" }
				: result.outcome === "durability_failure"
					? { kind: "durability_failure" }
					: { kind: "conflict" },
	);

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
	const scheduledRef = (target: ScheduledTarget): BlobReference => ({ kind: "scheduled", target });
	const applyRefs = (domainId: string, sets: readonly { ref: BlobReference; blobIds: readonly string[] }[]) => {
		deps.referenceHeld.applyRefs(domainId, sets);
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
		const store = deps.registry.for(domainId);
		const existing = store.list("scheduled").find((record) => record.clear.opId === input.opId);
		if (existing) {
			const record = ScheduledRecordSchema.parse({ ...existing.clear, version: existing.version });
			return envelope(sender, OP_OUTCOME_ACCEPTED, { state: record.state, version: record.version });
		}
		for (const file of input.files)
			if (!deps.referenceHeld.has(domainId, file)) return envelope(sender, "refused", { reason: "file" });
		const id = recordId(input.target);
		const current = store.get("scheduled", id);
		if (current?.clear.state === "firing") return envelope(sender, "conflict", { version: current.version });
		const expected = current ? (input.expectedVersion ?? null) : null;
		if (current ? expected !== current.version : input.expectedVersion !== undefined)
			return envelope(sender, "conflict", { version: current?.version });
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
		const folded = foldWriteResult(write);
		if (!folded.applied) return envelope(sender, folded.outcome === "conflict" ? "conflict" : folded.outcome);
		applyRefs(domainId, [{ ref: scheduledRef(input.target), blobIds: input.files }]);
		scheduleTimer(domainId, input.target, input.fireAt);
		const version = writeVersion(write, (current?.version ?? 0) + 1);
		const pending = resultRow(domainId, { ...record, version } as ScheduledRecord, "pending");
		if (pending.outcome !== OP_OUTCOME_ACCEPTED)
			return envelope(sender, folded.outcome === OP_OUTCOME_ACCEPTED ? "durability_uncertain" : folded.outcome);
		return envelope(sender, folded.outcome, { version });
	}

	function cancel(domainId: string, target: ScheduledTarget, expectedVersion: number) {
		const store = deps.registry.for(domainId);
		const current = store.get("scheduled", recordId(target));
		if (!current || current.version !== expectedVersion)
			return { outcome: "refused", reason: "conflict", version: current?.version };
		if (current.clear.state === "firing")
			return { outcome: "refused", reason: "conflict", version: current.version };
		if (TERMINAL.has(String(current.clear.state))) return { outcome: "refused", reason: "settled" };
		const record = ScheduledRecordSchema.parse({
			...current.clear,
			state: "cancelled",
			version: current.version + 1,
		});
		const write = store.put("scheduled", current.id, expectedVersion, { clear: record });
		if (!foldWriteResult(write).applied) return { outcome: "refused", reason: "conflict" };
		clearTimer(domainId, target);
		applyRefs(domainId, [{ ref: scheduledRef(target), blobIds: [] }]);
		return { outcome: OP_OUTCOME_ACCEPTED, version: writeVersion(write, current.version + 1) };
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
		const firingFold = foldWriteResult(firing);
		if (!firingFold.applied) {
			if (firingFold.outcome === "conflict") return { outcome: "conflict" };
			retryLater(domainId, target);
			return { outcome: firingFold.outcome };
		}
		const firingVersion = writeVersion(firing, current.version + 1);
		// Fire via the op ledger.
		const sent = deps.appendScheduledMessage(
			domainId,
			addressOf(target),
			messageKey(record),
			record.body,
			record.files,
		);
		if (foldAppendResult(sent).applied) {
			const done = store.put("scheduled", current.id, firingVersion, {
				clear: { ...record, state: "fired", attempts: record.attempts + 1 },
			});
			if (foldWriteResult(done).applied) {
				const result = resultRow(domainId, record, "sent", sent.seq);
				if (result.outcome === "refused" || result.outcome === "durability_failure") {
					const retry = store.put("scheduled", current.id, writeVersion(done, firingVersion), {
						clear: { ...record, state: "armed", attempts: record.attempts + 1 },
					});
					if (foldWriteResult(retry).applied) retryLater(domainId, target);
					return sent;
				}
				const refs = [{ ref: scheduledRef(target), blobIds: [] as string[] }];
				if (sent.seq !== undefined)
					refs.push({
						ref: { kind: "row" as const, address: addressOf(target), seq: sent.seq },
						blobIds: record.files,
					});
				if (result.row)
					refs.push({
						ref: { kind: "row" as const, address: ownerAddress(domainId), seq: result.row.seq },
						blobIds: record.files,
					});
				applyRefs(domainId, refs);
			} else retryLater(domainId, target);
			return sent;
		}
		const attempts = record.attempts + 1;
		if (attempts < 2) {
			const retry = store.put("scheduled", current.id, firingVersion, {
				clear: { ...record, state: "armed", attempts },
			});
			if (foldWriteResult(retry).applied || foldWriteResult(retry).outcome !== "conflict")
				retryLater(domainId, target);
			return sent;
		}
		const failed = store.put("scheduled", current.id, firingVersion, {
			clear: { ...record, state: "error", attempts },
		});
		if (!foldWriteResult(failed).applied && foldWriteResult(failed).outcome !== "conflict") {
			retryLater(domainId, target);
			return sent;
		}
		const result = resultRow(domainId, record, "failed");
		if (result.outcome === "refused" || result.outcome === "durability_failure") {
			const retry = store.put("scheduled", current.id, writeVersion(failed, firingVersion), {
				clear: { ...record, state: "armed", attempts },
			});
			if (foldWriteResult(retry).applied) retryLater(domainId, target);
			return sent;
		}
		applyRefs(domainId, [{ ref: scheduledRef(target), blobIds: [] }]);
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
