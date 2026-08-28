// The replay rule and the activity-append rule, tested where they LIVE rather than through either
// backend's service.
//
// Both rules existed twice, and both had drifted: Copilot searched with a first-match loop that
// could not see a second claimant, skipped the durability check entirely, and reported an operation
// the gateway had explicitly failed to confirm as a completed replay. None of that was user-visible,
// because both routes branch only on `disposition === "committed"` - which is exactly why it
// survived. A mock harness per backend would have proved agreement only for the cases somebody
// thought to write down; one owner plus the residue sweep below makes disagreement unspellable.

import fs from "node:fs";
import path from "node:path";
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

const SRC = path.join(import.meta.dirname, "..");
const OWNER = path.join("shared", "agent-record.ts");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Comparing an operation's fingerprint is the one move only a replay makes: an ordinary lookup
 * matches on operationId, which is why THAT cannot be the pattern (it is the legitimate way to find
 * an operation inside one agent, and appears a dozen times). Scoped to the gateway, since the
 * persisted-record self-check in `shared/codexAgentRecord.ts` compares a fingerprint for an
 * unrelated reason - it recomputes rather than matches. */
const COMPARES_A_FINGERPRINT = /\.fingerprint\s*(?:===|!==)/;

/** Building a truncation marker by incrementing the count. `localAgentRuntime.ts` carries an
 * existing `omitted` forward when it projects a turn, which is not this. */
const BUILDS_A_TRUNCATION = /omitted:\s*\w+\s*\+\s*1/;

/** Calling a raw fingerprint function rather than deriving one from an identity. The three owners
 * that legitimately define these wrappers are exempted by name at the call site below. */
const MINTS_A_FINGERPRINT = /\bagentOperationFingerprint\(|\b(?:codex|copilot)OperationFingerprint\(/;

/** Rebuilding the stored-to-published activity projection by hand, i.e. rewriting a commentary item
 * to drop its itemId. Both routes spelled this identically before it had an owner. */
const PROJECTS_ACTIVITIES = /kind === "commentary"\s*\?\s*\{\s*kind/;

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

// Scope, stated so it is not mistaken for a proof: these are TEXT sweeps over TypeScript in src/,
// the same mechanism as every other residue test here. They catch a rule rewritten in the obvious
// spelling, which is how both of these were rewritten. They do NOT catch a bracket access, a
// destructure, an equality moved into a helper, or an increment written as `(prior ?? 0) + 1`, and
// they read comments and strings as if they were code. An AST check would close that, and would be
// worth building for the whole family of residue tests rather than for this one.
describe("residue", () => {
	// A sweep reports "clean" by finding nothing, which is also what a broken walk reports. These are
	// the two files that HELD the duplicated rules before this refactor.
	it("the scan reaches the files that used to hold the rules", () => {
		const scanned = new Set(sourceFiles(SRC).map((f) => path.relative(SRC, f)));
		expect(scanned).toContain(path.join("gateway", "codexAgentService.ts"));
		expect(scanned).toContain(path.join("gateway", "copilotAgentService.ts"));
		expect(scanned).toContain(path.join("gateway", "codexAgentReducers.ts"));
	});

	it("no gateway module compares an operation fingerprint of its own", () => {
		const offenders = sourceFiles(path.join(SRC, "gateway")).filter((file) =>
			COMPARES_A_FINGERPRINT.test(fs.readFileSync(file, "utf8")),
		);
		expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
	});

	// The contract this item was filed to create. Codex minted a start fingerprint without the model
	// and Copilot minted one with it, because each spelled its own input at its own call site. No
	// production module may spell one again: they go through `agentOperationFingerprintOf`, and each
	// family's legacy era is stamped by its own `*OperationIdentity` rather than named at a call site.
	// Tests are exempt because building a legacy-shaped record on purpose is how the tolerance is
	// proven at all.
	it("no module outside the identity owners mints a fingerprint of its own", () => {
		const owners = new Set([
			OWNER,
			path.join("shared", "codexAgentIdentity.ts"),
			path.join("shared", "copilot-agent.ts"),
		]);
		const offenders = sourceFiles(SRC)
			.map((file) => path.relative(SRC, file))
			.filter(
				(rel) => !owners.has(rel) && MINTS_A_FINGERPRINT.test(fs.readFileSync(path.join(SRC, rel), "utf8")),
			);
		expect(offenders).toEqual([]);
	});

	// The same class as issue #271, which shipped: a published projection drifting from its sibling
	// while every test kept passing. Both routes wrote this out identically before it had an owner.
	it("nothing outside agent-record.ts projects a stored activity for publication", () => {
		const offenders = sourceFiles(SRC)
			.map((file) => path.relative(SRC, file))
			.filter((rel) => rel !== OWNER && PROJECTS_ACTIVITIES.test(fs.readFileSync(path.join(SRC, rel), "utf8")));
		expect(offenders).toEqual([]);
	});

	it("nothing outside agent-record.ts builds a truncation marker", () => {
		const offenders = sourceFiles(SRC)
			.map((file) => path.relative(SRC, file))
			.filter((rel) => rel !== OWNER && BUILDS_A_TRUNCATION.test(fs.readFileSync(path.join(SRC, rel), "utf8")));
		expect(offenders).toEqual([]);
	});

	// Positive controls: without these both sweeps pass vacuously the moment a pattern stops matching.
	it("the residue patterns match the shapes they are meant to catch", () => {
		expect(COMPARES_A_FINGERPRINT.test("if (operation.fingerprint !== fingerprint)")).toBe(true);
		expect(COMPARES_A_FINGERPRINT.test("if (matches[0]!.operation.fingerprint === fingerprint)")).toBe(true);
		expect(COMPARES_A_FINGERPRINT.test("const fingerprint = codexOperationFingerprint(kind, id)")).toBe(false);
		expect(BUILDS_A_TRUNCATION.test('{ kind: "truncated", omitted: omitted + 1 }')).toBe(true);
		expect(BUILDS_A_TRUNCATION.test('{ kind: "truncated" as const, omitted: prior + 1 }')).toBe(true);
		expect(BUILDS_A_TRUNCATION.test('{ kind: "truncated" as const, omitted: turn.omitted }')).toBe(false);
		expect(MINTS_A_FINGERPRINT.test('codexOperationFingerprint("start", agentId, prompt)')).toBe(true);
		expect(MINTS_A_FINGERPRINT.test("agentOperationFingerprint(kind, agentId, prompt)")).toBe(true);
		expect(MINTS_A_FINGERPRINT.test("agentOperationFingerprintOf(identity)")).toBe(false);
		expect(
			PROJECTS_ACTIVITIES.test(
				'activity.kind === "commentary" ? { kind: activity.kind, text: activity.text } : a',
			),
		).toBe(true);
		expect(PROJECTS_ACTIVITIES.test("publishedActivities(turn?.activities)")).toBe(false);
	});
});
