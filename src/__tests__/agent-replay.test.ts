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
	type AgentReplayOperation,
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

const op = (over: Partial<AgentReplayOperation> = {}): AgentReplayOperation => ({
	operationId: "op-1",
	fingerprint: "fp-1",
	state: "accepted",
	...over,
});
const durable = () => true;
const notDurable = () => false;

////////////////////////////////
//  Tests

describe("replay lookup", () => {
	it("finds nothing for an operation ID the catalog has never seen", () => {
		expect(resolveAgentReplay([{ operations: [op({ operationId: "other" })] }], "op-1", "fp-1", durable)).toEqual({
			kind: "none",
		});
		expect(resolveAgentReplay([], "op-1", "fp-1", durable)).toEqual({ kind: "none" });
	});

	it("replays an accepted operation over a durable catalog", () => {
		const found = resolveAgentReplay([{ operations: [op()] }], "op-1", "fp-1", durable);
		expect(found).toMatchObject({ kind: "match", replayable: true });
	});

	// A reused ID with different input, which is what a changed fingerprint means.
	it("refuses a fingerprint that does not match", () => {
		expect(resolveAgentReplay([{ operations: [op()] }], "op-1", "fp-2", durable)).toMatchObject({
			kind: "conflict",
		});
	});

	// Copilot returned the FIRST hit here and never looked further. Nothing may resolve this by
	// picking one, because nothing distinguishes the copies.
	it("refuses an operation ID held by two agents rather than picking one", () => {
		const found = resolveAgentReplay([{ operations: [op()] }, { operations: [op()] }], "op-1", "fp-1", durable);
		expect(found).toMatchObject({ kind: "conflict" });
	});

	it("searches across every agent, not only the first", () => {
		const found = resolveAgentReplay(
			[{ operations: [op({ operationId: "other" })] }, { operations: [op()] }],
			"op-1",
			"fp-1",
			durable,
		);
		expect(found).toMatchObject({ kind: "match", replayable: true });
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
	});
});
