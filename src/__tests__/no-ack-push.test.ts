import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_TRASH_TTL_MS, type BoardNotice, BoardStore, OWNER_ACTOR } from "../gateway/boardStore.js";
import { createNoAckPush, isNoAckSessionId, renderNoAckBody, type SessionLiveness } from "../gateway/noAckPush.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import { DurableStore } from "../shared/durable-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import type { ChannelPushPayload } from "../shared/types.js";

const OWNER = "owner-1";
const SESSION = "proj.main";

function entry(id: string, over: Partial<BoardEntry> = {}): BoardEntry {
	return { id, title: `t-${id}`, state: "open", rank: "m", ...over };
}

describe("what a board write announces", () => {
	let dir: string;
	let store: BoardStore;
	let announced: BoardNotice[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-ack-"));
		announced = [];
		store = new BoardStore(new DurableStore(dir, "task-board"), new PlaneRegistry(), undefined, (notices) => {
			announced.push(...notices);
		});
		store.upsert(OWNER, [entry("a"), entry("a1", { parent: "a" })], OWNER_ACTOR);
		store.claim(OWNER, "a", SESSION);
		announced.length = 0;
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("tells the holder the owner edited an entry, by id alone", () => {
		store.setTitle(OWNER, "a", "renamed", OWNER_ACTOR);
		expect(announced).toEqual([{ sessionId: SESSION, entryId: "a", kind: "changed" }]);
	});

	it("says nothing when the holder is the one writing", () => {
		// Every write through the /task-board route is a self-echo, so without this the board's
		// highest-volume writer announces its own work back to itself.
		store.setState(OWNER, "a", "in_progress", { kind: "session", sessionId: SESSION });
		expect(announced).toEqual([]);
	});

	it("carries the title when the entry goes back to the backlog, since its id stops resolving", () => {
		store.setSession(OWNER, "a", undefined);
		expect(announced).toContainEqual({ sessionId: SESSION, entryId: "a", kind: "backlog", title: "t-a" });
	});

	it("distinguishes trashed, removed and reassigned rather than collapsing them into gone", () => {
		store.setTrashed(OWNER, "a", true);
		expect(announced).toContainEqual({
			sessionId: SESSION,
			entryId: "a",
			kind: "gone",
			title: "t-a",
			how: "trashed",
		});

		announced.length = 0;
		store.setTrashed(OWNER, "a", false);
		store.setSession(OWNER, "a", "other.session");
		expect(announced).toContainEqual({
			sessionId: SESSION,
			entryId: "a",
			kind: "gone",
			title: "t-a",
			how: "reassigned",
		});

		announced.length = 0;
		store.setSession(OWNER, "a", SESSION);
		announced.length = 0;
		store.remove(OWNER, ["a1", "a"]);
		expect(announced).toContainEqual({
			sessionId: SESSION,
			entryId: "a",
			kind: "gone",
			title: "t-a",
			how: "removed",
		});
	});

	it("announces every subtree member a single commit touched", () => {
		store.setSession(OWNER, "a", undefined);
		expect(announced.map((n) => n.entryId).sort()).toEqual(["a", "a1"]);
	});

	it("says nothing for a refused write, or one that changed nothing", () => {
		expect(store.setTitle(OWNER, "a", "t-a", OWNER_ACTOR)).toEqual({ applied: true });
		expect(store.claim(OWNER, "a", "other.session")).toEqual({ applied: false, refused: "held" });
		expect(announced).toEqual([]);
	});

	it("says nothing about an unheld entry, since there is nobody to tell", () => {
		store.upsert(OWNER, [entry("loose")], OWNER_ACTOR);
		store.setTitle(OWNER, "loose", "renamed", OWNER_ACTOR);
		expect(announced).toEqual([]);
	});

	it("stays quiet when a session ends", () => {
		store.sessionEnded(SESSION, "release");
		expect(announced).toEqual([]);
	});

	it("does not re-announce a take-away for an entry already out of the holder's list", () => {
		// The owner tidying a title in the trash is not a second take-away.
		store.setTrashed(OWNER, "a", true);
		announced.length = 0;
		store.setTitle(OWNER, "a", "tidied", OWNER_ACTOR);
		store.setSession(OWNER, "a", undefined);
		expect(announced).toEqual([]);
	});

	it("says an untrashed entry came back rather than borrowing the edit wording", () => {
		// The holder was told it was gone and told to stop, so "the owner edited it" would not tell
		// them it is theirs again.
		store.setTrashed(OWNER, "a", true);
		announced.length = 0;
		store.setTrashed(OWNER, "a", false);
		expect(announced).toContainEqual({
			sessionId: SESSION,
			entryId: "a",
			kind: "arrived",
			title: "t-a",
		});
	});

	it("tells a session about work it just gained", () => {
		store.upsert(OWNER, [entry("fresh")], OWNER_ACTOR);
		announced.length = 0;
		store.setSession(OWNER, "fresh", SESSION);
		expect(announced).toEqual([{ sessionId: SESSION, entryId: "fresh", kind: "arrived", title: "t-fresh" }]);
	});

	it("tells both sides of a reassign, each what happened to them", () => {
		store.setSession(OWNER, "a1", "other.session");
		announced.length = 0;
		store.setSession(OWNER, "a1", SESSION);
		expect(announced).toContainEqual({
			sessionId: "other.session",
			entryId: "a1",
			kind: "gone",
			title: "t-a1",
			how: "reassigned",
		});
		expect(announced).toContainEqual({ sessionId: SESSION, entryId: "a1", kind: "arrived", title: "t-a1" });
	});

	it("stays quiet when the trash is swept, since the take-away happened at the trash", () => {
		store.setTrashed(OWNER, "a", true, 1_000);
		announced.length = 0;
		store.sweepTrash(1_000 + BOARD_TRASH_TTL_MS + 1);
		expect(store.entry(OWNER, "a")).toBeUndefined();
		expect(announced).toEqual([]);
	});
});

describe("the notice body", () => {
	const changed = (entryId: string): BoardNotice => ({ sessionId: SESSION, entryId, kind: "changed" });

	it("names one edited entry, and counts several", () => {
		expect(renderNoAckBody([changed("bd_a")])).toBe("The owner edited bd_a.");
		expect(renderNoAckBody([changed("bd_a"), changed("bd_b")])).toBe(
			"The owner edited 2 entries you hold: bd_a, bd_b.",
		);
	});

	it("states a take-away and adds nothing after it", () => {
		// Never that the entry can be claimed again: that presumes the agent wants it back and turns an
		// awareness signal into an instruction.
		const body = renderNoAckBody([
			{ sessionId: SESSION, entryId: "bd_a", kind: "backlog", title: "Ship the board" },
			{ sessionId: SESSION, entryId: "bd_b", kind: "gone", title: "Purge the old ranks", how: "trashed" },
		]);
		expect(body).toBe('"Ship the board" went back to the backlog.\n"Purge the old ranks" was trashed.');
	});

	it("flattens a multi-line title so the notice stays one line per fact", () => {
		const body = renderNoAckBody([
			{ sessionId: SESSION, entryId: "bd_a", kind: "backlog", title: "Fix login\nand logout" },
		]);
		expect(body).toBe('"Fix login and logout" went back to the backlog.');
	});
});

describe("delivery", () => {
	let liveness: SessionLiveness;
	let sent: ChannelPushPayload[];

	function push() {
		return createNoAckPush({
			liveness: () => liveness,
			deliver: (_key, payload) => {
				sent.push(payload);
				return true;
			},
		});
	}

	beforeEach(() => {
		liveness = "live";
		sent = [];
	});

	const notice = (entryId: string): BoardNotice => ({ sessionId: SESSION, entryId, kind: "changed" });

	it("folds a burst into one push rather than re-exploding a batch the console already assembled", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.bank([notice("bd_b")]);
		p.tick(Date.now() + 5_000);
		expect(sent).toHaveLength(1);
		expect(sent[0].body).toBe("The owner edited 2 entries you hold: bd_a, bd_b.");
	});

	it("counts an entry once however many times the owner wrote to it", () => {
		// The edit screen's Save alone fires title and body as two commits, so without a union the
		// commonest gesture there is renders as "2 entries you hold: bd_a, bd_a".
		const p = push();
		p.bank([notice("bd_a")]);
		p.bank([notice("bd_a")]);
		p.bank([notice("bd_a")]);
		p.tick(Date.now() + 5_000);
		expect(sent[0].body).toBe("The owner edited bd_a.");
	});

	it("corrects a take-away the owner undoes inside the window, rather than stranding it", () => {
		// A take-away means the agent must stop and must not retry, so a stale one costs it live work
		// permanently. The arrival lands on the same bank key and supersedes it.
		const p = push();
		p.bank([{ sessionId: SESSION, entryId: "bd_a", kind: "backlog", title: "Ship it" }]);
		p.bank([{ sessionId: SESSION, entryId: "bd_a", kind: "arrived", title: "Ship it" }]);
		p.tick(Date.now() + 5_000);
		expect(sent[0].body).toBe('"Ship it" is yours.');
	});

	it("bounds the body, since one console tap can walk a subtree of thousands", () => {
		const p = push();
		p.bank(
			Array.from({ length: 500 }, (_, i) => ({
				sessionId: SESSION,
				entryId: `bd_${i}`,
				kind: "gone" as const,
				title: `t-${i}`,
				how: "trashed" as const,
			})),
		);
		p.tick(Date.now() + 5_000);
		expect(sent[0].body.split("\n")).toHaveLength(21);
		expect(sent[0].body).toContain("And 480 more.");
	});

	it("lets the later fact win, so an edit then a trash reads as trashed alone", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.bank([{ sessionId: SESSION, entryId: "bd_a", kind: "gone", title: "Ship it", how: "trashed" }]);
		p.tick(Date.now() + 5_000);
		expect(sent[0].body).toBe('"Ship it" was trashed.');
	});

	it("holds nothing back before its window is up", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.tick(Date.now());
		expect(sent).toEqual([]);
	});

	it("drains on the session's own next board call, which is when it is certainly listening", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.tick(Date.now() + 5_000);
		expect(sent).toHaveLength(1);
	});

	it("asks for no reply and routes nowhere", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.tick(Date.now() + 5_000);
		expect(sent[0].no_ack).toBe(true);
		expect(isNoAckSessionId(sent[0].session_id)).toBe(true);
	});

	it("waits out a wake instead of dropping a session that never left", () => {
		const p = push();
		const t0 = Date.now();
		p.bank([notice("bd_a")]);
		liveness = "waking";
		p.tick(t0 + 5_000);
		expect(sent).toEqual([]);

		liveness = "live";
		p.tick(t0 + 10_000);
		expect(sent).toHaveLength(1);
	});

	it("gives up on a session that is still not there after the hold", () => {
		// The hold matches the gateway's own wake budget: anything shorter discards notices for wakes
		// that go on to succeed, and a devcontainer cold start runs well past a small number.
		const p = push();
		const t0 = Date.now();
		p.bank([notice("bd_a")]);
		liveness = "waking";
		p.tick(t0 + 700_000);
		liveness = "live";
		p.tick(t0 + 800_000);
		expect(sent).toEqual([]);
	});

	it("keeps holding through a long wake rather than dropping one that succeeds", () => {
		const p = push();
		const t0 = Date.now();
		p.bank([notice("bd_a")]);
		liveness = "waking";
		p.tick(t0 + 120_000);
		liveness = "live";
		p.tick(t0 + 130_000);
		expect(sent).toHaveLength(1);
	});

	it("drops a banked notice rather than delivering it to a session that is gone", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		liveness = "gone";
		p.tick(Date.now() + 5_000);
		liveness = "live";
		p.tick(Date.now() + 10_000);
		expect(sent).toEqual([]);
	});

	it("forgets what was banked for a session whose work just ended", () => {
		const p = push();
		p.bank([notice("bd_a")]);
		p.dropFor(SESSION);
		p.tick(Date.now() + 5_000);
		expect(sent).toEqual([]);
	});
});
