// Requests settle once and expire at their deadline.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import {
	VAULT_REQUEST_DEADLINE_MS,
	type VaultApprovedDecision,
	type VaultDecision,
	type VaultRequest,
} from "../../shared/schemasVault.js";
import { operationShape } from "./decisions.js";

export type VaultRequestInput =
	| { kind: "entry"; entryId: string; operation: string; sessionTarget: string }
	| { kind: "typed"; operation: string; sessionTarget: string };

export type VaultRequestAnswer =
	| { kind: "approved"; decision: VaultApprovedDecision; typedValue?: string }
	| { kind: "refused" };

export type VaultRequestOpened =
	| { kind: "opened"; request: VaultRequest; answer: Promise<VaultRequestAnswer> }
	| { kind: "undeliverable"; reason: "migrating" | "unreachable" };

export interface VaultRequestsDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Only queued rows open requests. */
	deliver: (request: VaultRequest) => boolean | typeof MIGRATING;
	/** Opens typed values with request AAD. */
	openTyped: (envelope: ContentEnvelope, requestId: string) => string | null;
	onApproved?: (request: VaultRequest, decision: VaultDecision) => void;
	deadlineMs?: number;
}

interface Pending {
	request: VaultRequest;
	timer: TimerHandle;
	answer: Promise<VaultRequestAnswer>;
	settle: (answer: VaultRequestAnswer) => void;
	settled: boolean;
}

export function createVaultRequests(deps: VaultRequestsDeps) {
	const deadlineMs = deps.deadlineMs ?? VAULT_REQUEST_DEADLINE_MS;
	const pending = new Map<string, Pending>();

	/** Only one collector removes a request. */
	const forget = (requestId: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry) return false;
		deps.ambient.clearTimer(entry.timer);
		pending.delete(requestId);
		return true;
	};

	const open = (input: VaultRequestInput): VaultRequestOpened => {
		const requestId = deps.ambient.newId();
		const shape = operationShape(input.operation);
		if (!shape) return { kind: "undeliverable", reason: "unreachable" };
		const common = {
			v: 1 as const,
			requestId,
			operation: input.operation,
			shape,
			sessionTarget: input.sessionTarget,
			deadlineAt: deps.ambient.now() + deadlineMs,
		};
		const request: VaultRequest =
			input.kind === "entry"
				? { kind: "entry", entryId: input.entryId, ...common }
				: { kind: "typed", ...common };
		const delivered = deps.deliver(request);
		if (delivered !== true)
			return { kind: "undeliverable", reason: delivered === MIGRATING ? "migrating" : "unreachable" };
		let settle: (answer: VaultRequestAnswer) => void = () => undefined;
		const answer = new Promise<VaultRequestAnswer>((resolve) => {
			settle = resolve;
		});
		const entry: Pending = {
			request,
			answer,
			settle: (result) => {
				if (entry.settled) return;
				entry.settled = true;
				settle(result);
			},
			settled: false,
			// The deadline ends an uncollected answer too.
			timer: deps.ambient.setTimer(() => {
				entry.settle({ kind: "refused" });
				pending.delete(requestId);
			}, deadlineMs),
		};
		pending.set(requestId, entry);
		return { kind: "opened", request, answer };
	};

	/** Answers are single-use. */
	const answer = (
		requestId: string,
		decision: VaultDecision,
		value?: ContentEnvelope,
	): { ok: true } | { ok: false; reason: string } => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled) return { ok: false, reason: "request expired" };
		if (deps.ambient.now() >= entry.request.deadlineAt) {
			entry.settle({ kind: "refused" });
			forget(requestId);
			return { ok: false, reason: "request expired" };
		}
		if (decision === "deny") {
			entry.settle({ kind: "refused" });
			return { ok: true };
		}
		if (entry.request.kind === "typed") {
			const typedValue = value ? deps.openTyped(value, requestId) : null;
			if (typedValue === null) return { ok: false, reason: "typed value unreadable" };
			entry.settle({ kind: "approved", decision, typedValue });
			return { ok: true };
		}
		deps.onApproved?.(entry.request, decision);
		entry.settle({ kind: "approved", decision });
		return { ok: true };
	};

	/** Collect only by session before deadline. */
	const collect = (requestId: string, sessionTarget: string): Pending | undefined => {
		const entry = pending.get(requestId);
		if (!entry || entry.request.sessionTarget !== sessionTarget) return undefined;
		if (deps.ambient.now() >= entry.request.deadlineAt) {
			entry.settle({ kind: "refused" });
			forget(requestId);
			return undefined;
		}
		return entry;
	};

	/** Session end refuses open requests. */
	const sessionEnded = (sessionTarget: string): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.request.sessionTarget !== sessionTarget) continue;
			entry.settle({ kind: "refused" });
			forget(requestId);
		}
	};

	return { open, answer, collect, forget, sessionEnded };
}

export type VaultRequests = ReturnType<typeof createVaultRequests>;
