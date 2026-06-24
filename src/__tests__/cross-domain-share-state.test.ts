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

// The share target builders + the linked-Domain predicate the gate supplies (a Domain is "trusted"
// iff it is a linked peer). Domain-specific shares ignore the predicate; everyone-trusted shares
// resolve through it.
const dom = (domainId: string) => ({ kind: "domain" as const, domainId });
const EVERYONE = { kind: "everyone_trusted" as const };
const ANY = () => true;
const linkedOnly =
	(...domains: string[]) =>
	(d: string) =>
		domains.includes(d);

describe("CrossDomainShareState store", () => {
	it("persists and reloads a share across instances (round-trip)", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", dom("carol"));

		// A fresh instance over the same dir reads the persisted file.
		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.all()).toHaveLength(1);
		expect(reloaded.isSharedTo("alpha/app", "carol", ANY)).toBe(true);
	});

	it("writes the file with 0600 perms", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", dom("carol"));
		const mode = fs.statSync(path.join(dir, "cross-domain-share-state.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("share/unshare/isSharedTo round-trip per (sessionTarget, target)", () => {
		const store = new CrossDomainShareState(tmp());
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(false);
		store.share("alpha/app", dom("carol"));
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(true);
		// Another Domain is independent.
		expect(store.isSharedTo("alpha/app", "dave", ANY)).toBe(false);
		store.unshare("alpha/app", dom("carol"));
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(false);
	});

	it("share is idempotent on the same (sessionTarget, target)", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		store.share("alpha/app", dom("carol"));
		expect(store.all()).toHaveLength(1);
	});

	it("an everyone-trusted share reaches ANY linked Domain and NO unlinked one", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", EVERYONE);
		// Reaches a linked Domain...
		expect(store.isSharedTo("alpha/app", "carol", linkedOnly("carol", "dave"))).toBe(true);
		expect(store.isSharedTo("alpha/app", "dave", linkedOnly("carol", "dave"))).toBe(true);
		// ...but never an unlinked one (the safety invariant).
		expect(store.isSharedTo("alpha/app", "eve", linkedOnly("carol", "dave"))).toBe(false);
		// A different session is not shared.
		expect(store.isSharedTo("alpha/lib", "carol", ANY)).toBe(false);
	});

	it("a domain share and an everyone-trusted share coexist on one session", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		store.share("alpha/app", EVERYONE);
		expect(store.all()).toHaveLength(2);
		// carol matches either record; an unlinked domain matches only via everyone-trusted (false here).
		expect(store.isSharedTo("alpha/app", "carol", linkedOnly("carol"))).toBe(true);
		expect(store.isSharedTo("alpha/app", "eve", linkedOnly("carol"))).toBe(false);
		// Unsharing everyone-trusted leaves the explicit carol share.
		store.unshare("alpha/app", EVERYONE);
		expect(store.all()).toHaveLength(1);
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(true);
	});

	it("sharesFor includes domain shares for it + every everyone-trusted share when it is linked", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		store.share("alpha/lib", dom("carol"));
		store.share("alpha/app", dom("dave"));
		store.share("alpha/svc", EVERYONE);
		// carol is linked: the explicit carol shares PLUS the everyone-trusted alpha/svc.
		expect(store.sharesFor("carol", linkedOnly("carol", "dave")).sort()).toEqual([
			"alpha/app",
			"alpha/lib",
			"alpha/svc",
		]);
		// dave is linked: its explicit share PLUS the everyone-trusted one.
		expect(store.sharesFor("dave", linkedOnly("carol", "dave")).sort()).toEqual(["alpha/app", "alpha/svc"]);
		// eve is NOT linked: the everyone-trusted share does not reach it, and it has no explicit share.
		expect(store.sharesFor("eve", linkedOnly("carol", "dave"))).toEqual([]);
	});

	it("touch refreshes lastSeenAt for every share of a session and persists", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", dom("carol"));
		store.share("alpha/app", dom("dave"));
		store.share("alpha/lib", dom("carol"));
		const before = store.all();

		const cutoffAge = 5000;
		const touchedNow = before[0].lastSeenAt + 10_000;
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

		const sweepNow = touchedNow + cutoffAge;
		const dropped = new CrossDomainShareState(dir).sweep(sweepNow, cutoffAge, NEVER_LIVE);
		expect(dropped).toBe(1); // only alpha/lib
		const after = new CrossDomainShareState(dir);
		expect(after.isSharedTo("alpha/app", "carol", ANY)).toBe(true);
		expect(after.isSharedTo("alpha/app", "dave", ANY)).toBe(true);
		expect(after.isSharedTo("alpha/lib", "carol", ANY)).toBe(false);
	});

	it("sweep drops a stale share past the ttl", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		const future = Date.now() + MONTH_MS + 1;
		const dropped = store.sweep(future, MONTH_MS, NEVER_LIVE);
		expect(dropped).toBe(1);
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(false);
	});

	it("sweep suppresses the forget while isLive returns true", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		const future = Date.now() + MONTH_MS + 1;
		const dropped = store.sweep(future, MONTH_MS, ALWAYS_LIVE);
		expect(dropped).toBe(0);
		expect(store.isSharedTo("alpha/app", "carol", ANY)).toBe(true);
	});

	it("sweep keeps a fresh share and persists a drop", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", dom("carol")); // fresh
		store.share("alpha/lib", dom("carol")); // will be selectively kept by isLive
		const future = Date.now() + MONTH_MS + 1;
		const dropped = store.sweep(future, MONTH_MS, (t) => t === "alpha/lib");
		expect(dropped).toBe(1);

		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.isSharedTo("alpha/app", "carol", ANY)).toBe(false);
		expect(reloaded.isSharedTo("alpha/lib", "carol", ANY)).toBe(true);
	});

	it("dropDomain drops only that Domain's specific shares (not everyone-trusted), and persists", () => {
		const dir = tmp();
		const store = new CrossDomainShareState(dir);
		store.share("alpha/app", dom("carol"));
		store.share("alpha/lib", dom("carol"));
		store.share("alpha/app", dom("dave"));
		store.share("alpha/svc", EVERYONE);

		// Unlinking Carol forgets only what was shared specifically to Carol; Dave's share + the
		// everyone-trusted share survive (everyone-trusted auto-stops reaching carol once unlinked).
		expect(store.dropDomain("carol")).toBe(2);
		expect(store.isSharedTo("alpha/app", "carol", linkedOnly("dave"))).toBe(false);
		expect(store.isSharedTo("alpha/lib", "carol", linkedOnly("dave"))).toBe(false);
		expect(store.isSharedTo("alpha/app", "dave", linkedOnly("dave"))).toBe(true);
		// The everyone-trusted share still reaches dave (still linked).
		expect(store.isSharedTo("alpha/svc", "dave", linkedOnly("dave"))).toBe(true);

		expect(store.dropDomain("carol")).toBe(0);

		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.all()).toHaveLength(2);
	});

	it("unshare on a missing record is a no-op", () => {
		const store = new CrossDomainShareState(tmp());
		store.share("alpha/app", dom("carol"));
		store.unshare("alpha/app", dom("dave"));
		store.unshare("alpha/other", dom("carol"));
		expect(store.all()).toHaveLength(1);
	});

	it("starts empty when the file is absent or corrupt", () => {
		const dir = tmp();
		expect(new CrossDomainShareState(dir).all()).toHaveLength(0);
		fs.writeFileSync(path.join(dir, "cross-domain-share-state.json"), "not json");
		expect(new CrossDomainShareState(dir).all()).toHaveLength(0);
	});
});
