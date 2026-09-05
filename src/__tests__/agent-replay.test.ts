import { describe, expect, it } from "vitest";
import {
	AGENT_ACTIVITY_MAX_ITEMS,
	type AgentOperationIdentity,
	type AgentReplayOperation,
	agentFingerprintVerdict,
	agentOperationFingerprint,
	agentOperationFingerprintOf,
	agentOperationReplayable,
	appendAgentActivity,
	resolveAgentReplay,
} from "../shared/agent-record.js";

const ID: AgentOperationIdentity = { kind: "message", agentId: "a-1", prompt: "p" };
const FP = agentOperationFingerprintOf(ID);

const op = (over: Partial<AgentReplayOperation> = {}): AgentReplayOperation => ({
	operationId: "op-1",
	fingerprint: FP,
	state: "accepted",
	...over,
});
const durable = () => true;
const notDurable = () => false;

describe("replay lookup", () => {
	it("finds nothing for an operation ID the catalog has never seen", () => {
		expect(resolveAgentReplay([{ operations: [op({ operationId: "other" })] }], "op-1", ID, durable)).toEqual({
			kind: "none",
		});
		expect(resolveAgentReplay([], "op-1", ID, durable)).toEqual({ kind: "none" });
	});

	it("replays an accepted operation over a durable catalog", () => {
		const found = resolveAgentReplay([{ operations: [op()] }], "op-1", ID, durable);
		expect(found).toMatchObject({ kind: "match", replayable: true });
	});

	it("refuses a fingerprint that does not match", () => {
		expect(resolveAgentReplay([{ operations: [op()] }], "op-1", { ...ID, prompt: "other" }, durable)).toMatchObject(
			{
				kind: "conflict",
			},
		);
	});

	it("refuses an operation ID held by two agents rather than picking one", () => {
		const found = resolveAgentReplay([{ operations: [op()] }, { operations: [op()] }], "op-1", ID, durable);
		expect(found).toMatchObject({ kind: "conflict" });
	});

	it("searches across every agent, not only the first", () => {
		const found = resolveAgentReplay(
			[{ operations: [op({ operationId: "other" })] }, { operations: [op()] }],
			"op-1",
			ID,
			durable,
		);
		expect(found).toMatchObject({ kind: "match", replayable: true });
	});

	it("replays a legacy model-less start on either family's spelling", () => {
		const codex = { kind: "start" as const, agentId: "a-1", prompt: "p" };
		expect(
			resolveAgentReplay(
				[{ operations: [op({ fingerprint: agentOperationFingerprint("start", "a-1", "p") })] }],
				"op-1",
				codex,
				durable,
			),
		).toMatchObject({ kind: "match" });
		const copilot = { ...codex, legacyModellessStart: "trailing-separator" as const };
		expect(
			resolveAgentReplay(
				[{ operations: [op({ fingerprint: agentOperationFingerprint("start", "a-1", "p\n") })] }],
				"op-1",
				copilot,
				durable,
			),
		).toMatchObject({ kind: "match" });
	});

	it("refuses to replay an operation whose fingerprint cannot be recomputed at all", () => {
		const unrecomputable = {
			kind: "start" as const,
			agentId: "a-1",
			prompt: "p",
			legacyModellessStart: "trailing-separator" as const,
		};
		const stored = op({ fingerprint: agentOperationFingerprint("start", "a-1", "p\nsome-model") });
		expect(resolveAgentReplay([{ operations: [stored] }], "op-1", unrecomputable, durable)).toMatchObject({
			kind: "conflict",
		});
	});
});

describe("fingerprint identity", () => {
	it("a start's model is part of what identifies it", () => {
		const base = { kind: "start" as const, agentId: "a-1", prompt: "p" };
		expect(agentOperationFingerprintOf({ ...base, model: "x" })).not.toBe(
			agentOperationFingerprintOf({ ...base, model: "y" }),
		);
		expect(agentOperationFingerprintOf({ ...base, model: "x" })).not.toBe(agentOperationFingerprintOf(base));
	});

	it("only a start folds in a model", () => {
		expect(agentOperationFingerprintOf({ kind: "message", agentId: "a", prompt: "p", model: "x" })).toBe(
			agentOperationFingerprintOf({ kind: "message", agentId: "a", prompt: "p" }),
		);
		expect(agentOperationFingerprintOf({ kind: "stop", agentId: "a", model: "x" })).toBe(
			agentOperationFingerprintOf({ kind: "stop", agentId: "a" }),
		);
	});

	it("a model-less start is spelled exactly as it always was", () => {
		expect(agentOperationFingerprintOf({ kind: "start", agentId: "a", prompt: "p" })).toBe(
			agentOperationFingerprint("start", "a", "p"),
		);
	});

	it("a tampered model-less start is a mismatch where no legacy era is declared", () => {
		const stored = agentOperationFingerprint("start", "a", "original");
		expect(agentFingerprintVerdict(stored, { kind: "start", agentId: "a", prompt: "tampered" })).toBe("mismatch");
	});

	it("a family with a legacy era answers unverifiable rather than tampered", () => {
		// Legacy model-less spellings cannot distinguish tampering.
		const stored = agentOperationFingerprint("start", "a", "original");
		expect(
			agentFingerprintVerdict(stored, {
				kind: "start",
				agentId: "a",
				prompt: "tampered",
				legacyModellessStart: "trailing-separator",
			}),
		).toBe("unverifiable");
	});

	it("a record that persists its model is checked strictly, with no legacy escape", () => {
		const identity = { kind: "start" as const, agentId: "a", prompt: "p", model: "x" };
		expect(agentFingerprintVerdict(agentOperationFingerprintOf(identity), identity)).toBe("match");
		expect(agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p"), identity)).toBe("mismatch");
		expect(
			agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p\nother"), {
				...identity,
				legacyModellessStart: "trailing-separator",
			}),
		).toBe("mismatch");
	});

	it("a legacy start that named a model verifies against the current encoding", () => {
		expect(
			agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p\nx"), {
				kind: "start",
				agentId: "a",
				prompt: "p",
				model: "x",
			}),
		).toBe("match");
	});

	it("an unrecomputable legacy record is unverifiable rather than either answer", () => {
		expect(
			agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p\nmodel"), {
				kind: "start",
				agentId: "a",
				prompt: "p",
				legacyModellessStart: "trailing-separator",
			}),
		).toBe("unverifiable");
	});

	it("without a declared legacy era nothing is tolerated", () => {
		expect(
			agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p\nsomething"), {
				kind: "start",
				agentId: "a",
				prompt: "p",
			}),
		).toBe("mismatch");
	});
});

describe("what may be reported as a completed replay", () => {
	it("a requested operation does not replay", () => {
		expect(agentOperationReplayable(op({ state: "requested" }), durable)).toBe(false);
	});

	it("an indeterminate operation does not replay", () => {
		expect(agentOperationReplayable(op({ state: "indeterminate" }), durable)).toBe(false);
	});

	it("an accepted operation whose acceptance was never fenced does not replay", () => {
		expect(agentOperationReplayable(op({ acceptanceUnverified: true }), durable)).toBe(false);
	});

	it("an accepted operation over an unconfirmable catalog does not replay", () => {
		expect(agentOperationReplayable(op(), notDurable)).toBe(false);
	});

	it("asks about durability for an operation that could otherwise replay", () => {
		let asked = 0;
		agentOperationReplayable(op(), () => {
			asked += 1;
			return true;
		});
		expect(asked).toBe(1);
	});

	it("does not ask about durability for an operation that cannot replay anyway", () => {
		// Non-replayable operations must not trigger durability writes.
		let asked = 0;
		const ask = () => {
			asked += 1;
			return true;
		};
		agentOperationReplayable(op({ state: "requested" }), ask);
		agentOperationReplayable(op({ state: "indeterminate" }), ask);
		agentOperationReplayable(op({ acceptanceUnverified: true }), ask);
		expect(asked).toBe(0);
	});
});

describe("activity append", () => {
	const commentary = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ kind: "commentary" as const, itemId: `i${i}`, text: `t${i}` }));

	it("appends a new item", () => {
		expect(appendAgentActivity([], "a", "hello", 3)).toEqual([{ kind: "commentary", itemId: "a", text: "hello" }]);
	});

	it("reports an item it already holds as null rather than appending twice", () => {
		expect(appendAgentActivity(commentary(1), "i0", "again", 3)).toBeNull();
	});

	it("keeps the earliest items and counts the rest", () => {
		const full = commentary(3);
		expect(appendAgentActivity(full, "late", "x", 3)).toEqual([...full, { kind: "truncated", omitted: 1 }]);
	});

	it("accumulates the omitted count across further items", () => {
		const withMarker = [...commentary(3), { kind: "truncated" as const, omitted: 4 }];
		expect(appendAgentActivity(withMarker, "later", "x", 3)).toEqual([
			...commentary(3),
			{ kind: "truncated", omitted: 5 },
		]);
	});

	it("takes its cap from the caller, so one shared bound moves both backends", () => {
		expect(
			appendAgentActivity(commentary(AGENT_ACTIVITY_MAX_ITEMS), "late", "x", AGENT_ACTIVITY_MAX_ITEMS),
		).toEqual([...commentary(AGENT_ACTIVITY_MAX_ITEMS), { kind: "truncated", omitted: 1 }]);
		expect(
			appendAgentActivity(commentary(AGENT_ACTIVITY_MAX_ITEMS), "late", "x", AGENT_ACTIVITY_MAX_ITEMS + 1),
		).toEqual([...commentary(AGENT_ACTIVITY_MAX_ITEMS), { kind: "commentary", itemId: "late", text: "x" }]);
	});
});
