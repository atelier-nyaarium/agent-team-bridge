import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainShareState } from "../gateway/federation/crossDomainShareState.js";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "xdomain-share-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NEVER_LIVE = () => false;
const ALWAYS_LIVE = () => true;
const MONTH_MS = 30 * 24 * 3600 * 1000;

describe("CrossDomainShareState store", () => {
	it("persists and reloads a share across instances (round-trip)", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", "carol");

		// A fresh instance over the same dir reads the persisted file.
		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.isSharedTo("alpha/app", "carol")).toBe(true);
	});

	it("writes the file with 0600 perms", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", "carol");
		const mode = fs.statSync(path.join(dir, "cross-domain-share-state.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("share/unshare/isSharedTo round-trip per (sessionTarget, toDomainId)", () => {
		const store = new CrossDomainShareState(tmp());
		expect(store.isSharedTo("alpha/app", "carol")).toBe(false);
		store.share("alpha/app", "carol");
		expect(store.isSharedTo("alpha/app", "carol")).toBe(true);
		// Another Domain is independent.
		expect(store.isSharedTo("alpha/app", "dave")).toBe(false);
		store.unshare("alpha/app", "carol");
		expect(store.isSharedTo("alpha/app", "carol")).toBe(false);
	});

	it("share is idempotent on the same (sessionTarget, toDomainId)", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", "carol");
		store.share("alpha/app", "carol");
		expect(store.all()).toHaveLength(1);
	});

	it("sharesFor filters by Domain", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", "carol");
		store.share("alpha/lib", "carol");
		store.share("alpha/app", "dave");
		expect(store.sharesFor("carol").sort()).toEqual(["alpha/app", "alpha/lib"]);
		expect(store.sharesFor("dave")).toEqual(["alpha/app"]);
		expect(store.sharesFor("eve")).toEqual([]);
	});

	it("touch refreshes lastSeenAt for every share of a session and persists", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", "carol");
		store.share("alpha/app", "dave");
		store.share("alpha/lib", "carol");
		const before = store.all();

		// A sweep cutoff sitting between the original lastSeenAt and the touched value:
		// touch lifts alpha/app above it, so a later sweep at that cutoff keeps both its
		// records while still forgetting the un-touched alpha/lib.
		const cutoffAge = 5000;
		const touchedNow = before[0].lastSeenAt + 10_000;
		// Pin time so touch is deterministic.
		const realNow = Date.now;
		Date.now = () => touchedNow;
		try {
			store.touch("alpha/app");
		} finally {
			Date.now = realNow;
		}

		const refreshed = new CrossDomainShareState(dir).all();
		for (const r of refreshed) {
			if (r.sessionTarget === "alpha/app") expect(r.lastSeenAt).toBe(touchedNow);
			else expect(r.lastSeenAt).toBe(before.find((b) => b.sessionTarget === r.sessionTarget)?.lastSeenAt);
		}

		// sweepNow is past alpha/lib's cutoff but within alpha/app's (because touch moved it forward).
		const sweepNow = touchedNow + cutoffAge;
		const dropped = new CrossDomainShareState(dir).sweep(sweepNow, cutoffAge, NEVER_LIVE);
		expect(dropped).toBe(1); // only alpha/lib
		const after = new CrossDomainShareState(dir);
		expect(after.isSharedTo("alpha/app", "carol")).toBe(true);
		expect(after.isSharedTo("alpha/app", "dave")).toBe(true);
		expect(after.isSharedTo("alpha/lib", "carol")).toBe(false);
	});

	it("sweep drops a stale share past the ttl", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", "carol");
		const future = Date.now() + MONTH_MS + 1;
		const dropped = store.sweep(future, MONTH_MS, NEVER_LIVE);
		expect(dropped).toBe(1);
		expect(store.isSharedTo("alpha/app", "carol")).toBe(false);
	});

	it("sweep suppresses the forget while isLive returns true", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", "carol");
		const future = Date.now() + MONTH_MS + 1;
		const dropped = store.sweep(future, MONTH_MS, ALWAYS_LIVE);
		expect(dropped).toBe(0);
		expect(store.isSharedTo("alpha/app", "carol")).toBe(true);
	});

	it("sweep keeps a fresh share and persists a drop", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", "carol"); // fresh
		store.share("alpha/lib", "carol"); // will be selectively kept by isLive
		const future = Date.now() + MONTH_MS + 1;
		// app is past ttl and not live -> dropped; lib is past ttl but live -> kept.
		const dropped = store.sweep(future, MONTH_MS, (t) => t === "alpha/lib");
		expect(dropped).toBe(1);

		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.isSharedTo("alpha/app", "carol")).toBe(false);
		expect(reloaded.isSharedTo("alpha/lib", "carol")).toBe(true);
	});

	it("dropDomain drops only that Domain's shares, returns the count, and persists", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", "carol");
		store.share("alpha/lib", "carol");
		store.share("alpha/app", "dave");

		// Unlinking Carol forgets only what was shared to Carol; Dave's share survives.
		expect(store.dropDomain("carol")).toBe(2);
		expect(store.isSharedTo("alpha/app", "carol")).toBe(false);
		expect(store.isSharedTo("alpha/lib", "carol")).toBe(false);
		expect(store.isSharedTo("alpha/app", "dave")).toBe(true);

		// Dropping an already-gone Domain removes nothing.
		expect(store.dropDomain("carol")).toBe(0);

		// The drop persisted: a fresh instance over the same dir keeps only Dave's share.
		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.isSharedTo("alpha/app", "dave")).toBe(true);
	});

	it("unshare on a missing record is a no-op", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", "carol");
		store.unshare("alpha/app", "dave");
		store.unshare("alpha/other", "carol");
		expect(store.all()).toHaveLength(1);
	});

	it("starts empty when the file is absent or corrupt", () => {
		const dir = tmp();
		expect(new CrossDomainShareState(dir).all()).toHaveLength(0);
		fs.writeFileSync(path.join(dir, "cross-domain-share-state.json"), "not json");
		expect(new CrossDomainShareState(dir).all()).toHaveLength(0);
	});
});
