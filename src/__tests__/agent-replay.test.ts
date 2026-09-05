// The replay and activity rules at their one owner.

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

////////////////////////////////
//  Functions & Helpers

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

////////////////////////////////
//  Tests

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

	// A reused ID with different input, which is what a changed fingerprint means.
	it("refuses a fingerprint that does not match", () => {
		expect(resolveAgentReplay([{ operations: [op()] }], "op-1", { ...ID, prompt: "other" }, durable)).toMatchObject(
			{
				kind: "conflict",
			},
		);
	});

	// Copilot returned the FIRST hit here and never looked further. Nothing may resolve this by
	// picking one, because nothing distinguishes the copies.
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

	// A pre-migration record must still replay, or every existing agent answers 400 to its first
	// retry after the deploy. Found by an existing catalog test rather than by design.
	it("replays a legacy model-less start on either family's spelling", () => {
		// Codex wrote the prompt alone, which is what the encoding still writes.
		const codex = { kind: "start" as const, agentId: "a-1", prompt: "p" };
		expect(
			resolveAgentReplay(
				[{ operations: [op({ fingerprint: agentOperationFingerprint("start", "a-1", "p") })] }],
				"op-1",
				codex,
				durable,
			),
		).toMatchObject({ kind: "match" });
		// Copilot appended a separator, which the tolerance recomputes exactly.
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

	// The opposite answer to the one a schema gives for the same verdict, and deliberately so: a
	// record that cannot be recomputed must not be dropped, but neither may it be called a replay.
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
	// The defect this item was filed for: Codex left the model out, Copilot folded it in, so the same
	// retry with a changed model replayed silently on one backend and conflicted on the other.
	it("a start's model is part of what identifies it", () => {
		const base = { kind: "start" as const, agentId: "a-1", prompt: "p" };
		expect(agentOperationFingerprintOf({ ...base, model: "x" })).not.toBe(
			agentOperationFingerprintOf({ ...base, model: "y" }),
		);
		expect(agentOperationFingerprintOf({ ...base, model: "x" })).not.toBe(agentOperationFingerprintOf(base));
	});

	// Neither kind ever carried a model, so neither gains one now.
	it("only a start folds in a model", () => {
		expect(agentOperationFingerprintOf({ kind: "message", agentId: "a", prompt: "p", model: "x" })).toBe(
			agentOperationFingerprintOf({ kind: "message", agentId: "a", prompt: "p" }),
		);
		expect(agentOperationFingerprintOf({ kind: "stop", agentId: "a", model: "x" })).toBe(
			agentOperationFingerprintOf({ kind: "stop", agentId: "a" }),
		);
	});

	// The whole reason the model term is conditional. A model-less start is the commonest record
	// there is, and this keeps its spelling identical to what Codex has always written, so it needs
	// no tolerance and its tamper check stays at full strength permanently. An unconditional
	// separator would have forced a tolerance that accepted two spellings for it forever.
	it("a model-less start is spelled exactly as it always was", () => {
		expect(agentOperationFingerprintOf({ kind: "start", agentId: "a", prompt: "p" })).toBe(
			agentOperationFingerprint("start", "a", "p"),
		);
	});

	// Found by Luna: the first version folded in an empty model term, so EVERY model-less start
	// needed the legacy branch and a tampered one was accepted for the life of the code. Codex now
	// declares no legacy era, so its check is at full strength permanently.
	it("a tampered model-less start is a mismatch where no legacy era is declared", () => {
		const stored = agentOperationFingerprint("start", "a", "original");
		expect(agentFingerprintVerdict(stored, { kind: "start", agentId: "a", prompt: "tampered" })).toBe("mismatch");
	});

	/**
	 * The residual, stated rather than hidden: a family that declares a legacy era cannot call a
	 * model-less start tampered.
	 *
	 * Its stored value matches neither spelling, and nothing distinguishes tampering from a
	 * pre-migration start whose model was folded in and never stored - inverting the hash is the only
	 * way to tell, so `unverifiable` is the honest answer. It costs nothing today: Copilot is the only
	 * family that declares an era and it had NO check at all before this. The replay path still
	 * refuses, since it needs a positive match.
	 */
	it("a family with a legacy era answers unverifiable rather than tampered", () => {
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
		// A known model means no legacy branch is reachable at all, so a wrong one is a mismatch even
		// for a family that declares an era.
		expect(
			agentFingerprintVerdict(agentOperationFingerprint("start", "a", "p\nother"), {
				...identity,
				legacyModellessStart: "trailing-separator",
			}),
		).toBe("mismatch");
	});

	// A legacy Copilot start that NAMED a model wrote the bytes the encoding writes today, so it
	// verifies outright once the caller names the same model. No tolerance is involved.
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

	// The one shape nothing can recompute: the model was folded in and never stored, and the reader
	// does not know which model it was.
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

	// Codex declares no legacy era at all, so nothing it holds is ever unverifiable.
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
	// Never confirmed by a daemon.
	it("a requested operation does not replay", () => {
		expect(agentOperationReplayable(op({ state: "requested" }), durable)).toBe(false);
	});

	// The gateway's own record of "I could not find out". Copilot mapped this to `replayed`, which
	// tells the caller a thing the gateway explicitly does not know.
	it("an indeterminate operation does not replay", () => {
		expect(agentOperationReplayable(op({ state: "indeterminate" }), durable)).toBe(false);
	});

	it("an accepted operation whose acceptance was never fenced does not replay", () => {
		expect(agentOperationReplayable(op({ acceptanceUnverified: true }), durable)).toBe(false);
	});

	it("an accepted operation over an unconfirmable catalog does not replay", () => {
		expect(agentOperationReplayable(op(), notDurable)).toBe(false);
	});

	// The durability call REPAIRS: a retry is evidence the operation matters, so it is worth one
	// fsync. Copilot never made this call at all, which is the real loss - the answer it gave
	// happened to be the same.
	it("asks about durability for an operation that could otherwise replay", () => {
		let asked = 0;
		agentOperationReplayable(op(), () => {
			asked += 1;
			return true;
		});
		expect(asked).toBe(1);
	});

	// Ordering, not a preference: an operation that was never replayable must not buy a write.
	it("does not ask about durability for an operation that cannot replay anyway", () => {
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

	// The retained window is the FIRST items: a turn's opening commentary explains what it decided to
	// do, and a late item can be read from the final response.
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

	// Copilot spelled this cap as a literal 32 while Codex read the shared bound, so raising the
	// bound would have moved one backend and not the other. Both now pass their own constant, and
	// both constants alias this one.
	it("takes its cap from the caller, so one shared bound moves both backends", () => {
		expect(
			appendAgentActivity(commentary(AGENT_ACTIVITY_MAX_ITEMS), "late", "x", AGENT_ACTIVITY_MAX_ITEMS),
		).toEqual([...commentary(AGENT_ACTIVITY_MAX_ITEMS), { kind: "truncated", omitted: 1 }]);
		expect(
			appendAgentActivity(commentary(AGENT_ACTIVITY_MAX_ITEMS), "late", "x", AGENT_ACTIVITY_MAX_ITEMS + 1),
		).toEqual([...commentary(AGENT_ACTIVITY_MAX_ITEMS), { kind: "commentary", itemId: "late", text: "x" }]);
	});
});
