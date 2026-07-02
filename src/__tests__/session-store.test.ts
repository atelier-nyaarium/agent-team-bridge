import { describe, expect, it } from "vitest";
import { SessionStore, sanitizeLabel } from "../shared/session-store.js";

// Deterministic ids for clash tests: yields the scripted values, then unique fillers.
function scriptedIds(...ids: string[]) {
	let extra = 0;
	return () => ids.shift() ?? `fill${extra++}`;
}

const LEGACY_FILE = {
	"host.switchboard": { claudeSessionId: "16aa1d0d-aaaa", lastSeen: 1000 },
	"host.story-telling": { claudeSessionId: "c1fa7689-bbbb", lastSeen: 2000 },
};

describe("SessionStore migration", () => {
	it("migrates a legacy resume map into full records seeded from the segment", () => {
		const store = new SessionStore();
		store.restore(LEGACY_FILE);
		expect(store.getByTeam("host.switchboard")).toMatchObject({
			id: "switchboard",
			sessionLabel: "switchboard",
			spawn: "host",
			workdirHint: "switchboard",
			claudeSessionId: "16aa1d0d-aaaa",
			confirmedAt: 1000,
			lastSeen: 1000,
		});
		expect(store.size).toBe(2);
	});

	it("a rename survives any number of snapshot/restore round-trips (a loaded record is not re-derived)", () => {
		const store = new SessionStore();
		store.restore(LEGACY_FILE);
		expect(store.rename("host.switchboard", "My Main Session")).toBe("My Main Session");

		let snap = store.snapshot();
		for (let boot = 0; boot < 3; boot++) {
			const next = new SessionStore();
			next.restore(snap);
			expect(next.getByTeam("host.switchboard")?.sessionLabel).toBe("My Main Session");
			snap = next.snapshot();
		}
	});

	it("keeps same-segment sessions across spawns distinct (composite keys never collide)", () => {
		const store = new SessionStore();
		store.restore({
			"host.claude": { claudeSessionId: "a-1", lastSeen: 1 },
			"recipe-app.claude": { claudeSessionId: "b-2", lastSeen: 2 },
		});
		expect(store.size).toBe(2);
		expect(store.getByTeam("host.claude")?.claudeSessionId).toBe("a-1");
		expect(store.getByTeam("recipe-app.claude")?.claudeSessionId).toBe("b-2");
	});

	it("skips keys that were never valid chats (the read-guard)", () => {
		const store = new SessionStore();
		store.restore({
			host: { claudeSessionId: "x", lastSeen: 1 },
			"host.UPPER": { claudeSessionId: "x", lastSeen: 1 },
			"host.ok": { lastSeen: 1 },
		});
		expect(store.size).toBe(0);
	});

	it("never restores a live pointer (a stamp cannot outlive its sockets)", () => {
		const store = new SessionStore();
		store.restore(LEGACY_FILE);
		store.bindBySegment("host.switchboard", { live: { team: "host.switchboard", subId: "s1" } });
		expect(store.resolveLive("host.switchboard")).toBeDefined();

		const next = new SessionStore();
		next.restore(store.snapshot());
		expect(next.resolveLive("host.switchboard")).toBeUndefined();
	});

	it("re-asserts label safety on restore, so a hand-edited store file cannot smuggle a path", () => {
		const store = new SessionStore();
		store.restore({
			"host.abc123": { id: "abc123", sessionLabel: "../escape", spawn: "host", workdirHint: "a/b", lastSeen: 1 },
		});
		expect(store.getByTeam("host.abc123")).toMatchObject({ sessionLabel: "abc123", workdirHint: undefined });
	});

	it("re-dedups labels on restore, so a hand-edited file with a shared label loads distinct", () => {
		const store = new SessionStore();
		store.restore({
			"host.aaa111": { id: "aaa111", sessionLabel: "dup", spawn: "host", lastSeen: 1 },
			"host.bbb222": { id: "bbb222", sessionLabel: "dup", spawn: "host", lastSeen: 2 },
		});
		const labels = [store.getByTeam("host.aaa111")?.sessionLabel, store.getByTeam("host.bbb222")?.sessionLabel];
		expect(new Set(labels).size).toBe(2);
		// The freed label is truly free after a forget (index stayed consistent).
		store.forget("host.aaa111");
		expect(store.mint({ spawn: "host", sessionLabel: "dup" }).sessionLabel).not.toBe(
			store.getByTeam("host.bbb222")?.sessionLabel,
		);
	});
});

describe("SessionStore composite keying", () => {
	it("bindBySegment rebinds the resume id onto the same record without duplicating", () => {
		const store = new SessionStore();
		store.adoptById("abc123", { spawn: "host", claudeSessionId: "t-1" });
		expect(store.getByTeam("host.abc123")).toMatchObject({ id: "abc123", spawn: "host", claudeSessionId: "t-1" });
		// A reconnect re-confirms the same team; one record, resume id refreshed.
		store.bindBySegment("host.abc123", { claudeSessionId: "t-2" });
		expect(store.size).toBe(1);
		expect(store.getByTeam("host.abc123")?.claudeSessionId).toBe("t-2");
	});

	it("two spawns sharing a segment stay separate, each resumable by its own transcript", () => {
		const store = new SessionStore();
		store.adoptById("claude", { spawn: "host", claudeSessionId: "host-tx" });
		store.adoptById("claude", { spawn: "recipe-app", claudeSessionId: "app-tx" });
		expect(store.size).toBe(2);
		expect(store.getByTeam("host.claude")?.claudeSessionId).toBe("host-tx");
		expect(store.getByTeam("recipe-app.claude")?.claudeSessionId).toBe("app-tx");
		store.forget("host.claude");
		expect(store.getByTeam("host.claude")).toBeUndefined();
		expect(store.getByTeam("recipe-app.claude")?.claudeSessionId).toBe("app-tx");
	});
});

describe("SessionStore mint / adopt", () => {
	it("mints a fresh id, re-rolling past existing records and the injected clash space", () => {
		const store = new SessionStore({
			clash: (id) => id === "reserved",
			idGen: scriptedIds("taken", "reserved", "fresh1"),
		});
		store.adoptById("taken", { spawn: "host" });
		const rec = store.mint({ spawn: "host", sessionLabel: "My Session" });
		expect(rec.id).toBe("fresh1");
		expect(rec.sessionLabel).toBe("My Session");
	});

	it("adopts a caller-supplied free id and refuses a taken or non-slug or reserved one", () => {
		const store = new SessionStore({ clash: (id) => id === "host-daemon" });
		expect(store.adoptById("mywork", { spawn: "host" })?.id).toBe("mywork");
		expect(store.adoptById("mywork", { spawn: "host" })).toBeNull();
		expect(store.adoptById("host-daemon", { spawn: "host" })).toBeNull();
		expect(store.adoptById("Bad Name", { spawn: "host" })).toBeNull();
		// The SAME id under a different spawn is a different session and is allowed.
		expect(store.adoptById("mywork", { spawn: "recipe-app" })?.id).toBe("mywork");
	});

	it("adoptOrReattach creates fresh, reattaches an existing record, and refuses a reserved id", () => {
		const store = new SessionStore({ clash: (id) => id === "host-daemon" });
		const first = store.adoptOrReattach("work", { spawn: "host", sessionLabel: "Work" });
		expect(first).toMatchObject({ created: true, record: { id: "work", sessionLabel: "Work" } });
		// A re-dispatch of the same id reattaches (no duplicate, no new label).
		const again = store.adoptOrReattach("work", { spawn: "host", sessionLabel: "ignored" });
		expect(again).toMatchObject({ created: false, record: { id: "work", sessionLabel: "Work" } });
		expect(store.size).toBe(1);
		// A reserved/clashing id with no record is refused.
		expect(store.adoptOrReattach("host-daemon", { spawn: "host" })).toBeNull();
	});
});

describe("SessionStore confirm-time binding", () => {
	it("bindResume finds the record holding the transcript, wherever it re-incarnates", () => {
		const store = new SessionStore();
		store.mint({ spawn: "host", sessionLabel: "phone session", claudeSessionId: "t-99" });
		const live = { team: "host.5f5f5f", subId: "s2" };
		const rec = store.bindResume("t-99", { live });
		expect(rec?.sessionLabel).toBe("phone session");
		expect(rec && store.resolveLive(store.teamOf(rec))).toEqual(live);
		expect(store.bindResume("unknown-transcript")).toBeNull();
	});

	it("clearLive drops only the exact (team, subId) incarnation, not a sibling sharing the team", () => {
		const store = new SessionStore();
		store.adoptById("aaa111", { spawn: "host" });
		store.adoptById("bbb222", { spawn: "host" });
		// Two records whose live sockets share a team but differ by subId (alias-bound incarnations).
		store.bindBySegment("host.aaa111", { live: { team: "host.zzz", subId: "s1" } });
		store.bindBySegment("host.bbb222", { live: { team: "host.zzz", subId: "s2" } });
		store.clearLive("host.zzz", "s1");
		expect(store.resolveLive("host.aaa111")).toBeUndefined();
		expect(store.resolveLive("host.bbb222")).toEqual({ team: "host.zzz", subId: "s2" });
	});

	it("confirm stamps the handshake time on a known team and is a no-op on an unknown one", () => {
		let clock = 500;
		const store = new SessionStore({ now: () => clock, idGen: scriptedIds("known1") });
		store.mint({ spawn: "host" });
		clock = 900;
		expect(store.confirm("host.known1")).toMatchObject({ confirmedAt: 900, lastSeen: 900 });
		expect(store.confirm("host.nosuch")).toBeUndefined();
	});
});

describe("SessionStore establishOnConfirm binding order", () => {
	const live = { team: "host.abc123", subId: "s1" };

	it("tier 1: binds an existing record its segment names, without duplicating", () => {
		const store = new SessionStore();
		store.adoptById("mywork", { spawn: "host", sessionLabel: "My Work" });
		const rec = store.establishOnConfirm("host.mywork", {
			claudeSessionId: "tx-9",
			live: { team: "host.mywork", subId: "s1" },
		});
		expect(store.size).toBe(1);
		expect(rec).toMatchObject({
			sessionLabel: "My Work",
			claudeSessionId: "tx-9",
			liveTeam: { team: "host.mywork", subId: "s1" },
		});
		expect(rec?.confirmedAt).toBeGreaterThan(0);
	});

	it("tier 2: binds the record holding a matching transcript id, under a fresh segment", () => {
		const store = new SessionStore();
		store.adoptById("orig", { spawn: "host", claudeSessionId: "tx-7" });
		const rec = store.establishOnConfirm("host.fresh1", {
			claudeSessionId: "tx-7",
			live: { team: "host.fresh1", subId: "s2" },
		});
		expect(store.size).toBe(1);
		expect(rec && store.teamOf(rec)).toBe("host.orig");
		expect(store.getByTeam("host.fresh1")).toBeUndefined();
	});

	it("tier 3: adopts a free segment and labels it by the reported cwd", () => {
		const store = new SessionStore();
		const rec = store.establishOnConfirm("host.abc123", { claudeSessionId: "tx-1", label: "switchboard", live });
		expect(rec).toMatchObject({ id: "abc123", sessionLabel: "switchboard", claudeSessionId: "tx-1" });
	});

	it("tier 4: mints a fresh id when the segment collides with a reserved id", () => {
		const store = new SessionStore({ clash: (id) => id === "evie-bot", idGen: scriptedIds("minted1") });
		const rec = store.establishOnConfirm("host.evie-bot", { label: "evie-bot", live });
		expect(store.getByTeam("host.evie-bot")).toBeUndefined();
		expect(rec).toMatchObject({ id: "minted1", sessionLabel: "evie-bot" });
	});

	it("a bare spawn-point team establishes no record", () => {
		const store = new SessionStore();
		expect(
			store.establishOnConfirm("someproj", { claudeSessionId: "tx-1", live: { team: "someproj", subId: "s1" } }),
		).toBeUndefined();
		expect(store.size).toBe(0);
	});
});

describe("SessionStore labels", () => {
	it("dedups labels per spawn with a -# suffix; other spawns may reuse the label", () => {
		const store = new SessionStore({ idGen: scriptedIds("id1", "id2", "id3") });
		expect(store.mint({ spawn: "host", sessionLabel: "switchboard" }).sessionLabel).toBe("switchboard");
		expect(store.mint({ spawn: "host", sessionLabel: "switchboard" }).sessionLabel).toBe("switchboard-2");
		expect(store.mint({ spawn: "recipe-app", sessionLabel: "switchboard" }).sessionLabel).toBe("switchboard");
	});

	it("frees a label on forget so it can be reused without a suffix", () => {
		const store = new SessionStore({ idGen: scriptedIds("id1", "id2") });
		store.mint({ spawn: "host", sessionLabel: "alpha" });
		expect(store.mint({ spawn: "host", sessionLabel: "alpha" }).sessionLabel).toBe("alpha-2");
		store.forget("host.id1");
		expect(store.mint({ spawn: "host", sessionLabel: "alpha" }).sessionLabel).toBe("alpha");
	});

	it("rename applies sanitization + dedup and reports the label actually applied", () => {
		const store = new SessionStore({ idGen: scriptedIds("id1", "id2") });
		store.mint({ spawn: "host", sessionLabel: "alpha" });
		store.mint({ spawn: "host", sessionLabel: "beta" });
		expect(store.rename("host.id2", "alpha")).toBe("alpha-2");
		expect(store.rename("host.id2", "../escape")).toBeNull();
		expect(store.getByTeam("host.id2")?.sessionLabel).toBe("alpha-2");
	});

	it("sanitizeLabel keeps free-form text but rejects path-unsafe or invisible input", () => {
		expect(sanitizeLabel("  My Cool Session!  ")).toBe("My Cool Session!");
		expect(sanitizeLabel("chat \u{1F600}")).toBe("chat \u{1F600}");
		expect(sanitizeLabel("a/b")).toBeNull();
		expect(sanitizeLabel("a\\b")).toBeNull();
		expect(sanitizeLabel("..")).toBeNull();
		expect(sanitizeLabel("tab\there")).toBeNull();
		expect(sanitizeLabel("\u200b\u200b\u200b")).toBeNull();
		expect(sanitizeLabel("abc\u202edef")).toBeNull();
		expect(sanitizeLabel("x\u0085y")).toBeNull();
		expect(sanitizeLabel("")).toBeNull();
		expect(sanitizeLabel("x".repeat(200))?.length).toBe(64);
	});

	it("caps on code points, so an astral character never truncates into a lone surrogate", () => {
		const capped = sanitizeLabel(`${"x".repeat(63)}\u{1F600}`);
		expect([...(capped ?? "")].length).toBe(64);
		expect(capped?.endsWith("\u{1F600}")).toBe(true);
	});

	it("mint falls back to safe defaults when the supplied label and hint are unsafe", () => {
		const store = new SessionStore({ idGen: scriptedIds("safe01") });
		const rec = store.mint({ spawn: "host", sessionLabel: "../evil", workdirHint: "a/b" });
		expect(rec.sessionLabel).toBe("safe01");
		expect(rec.workdirHint).toBeUndefined();
	});
});

describe("SessionStore TTL", () => {
	it("sweeps stale records while touch-refreshed (live) ones survive", () => {
		let clock = 0;
		const store = new SessionStore({ now: () => clock, idGen: scriptedIds("live01", "stale1") });
		store.mint({ spawn: "host", sessionLabel: "live" });
		store.mint({ spawn: "host", sessionLabel: "stale" });

		clock = 100;
		store.touchLive("host.live01");
		store.sweep(50);
		expect(store.getByTeam("host.live01")).toBeDefined();
		expect(store.getByTeam("host.stale1")).toBeUndefined();
	});

	it("forget removes the record and returns whether it existed", () => {
		const store = new SessionStore({ idGen: scriptedIds("gone12") });
		store.mint({ spawn: "host" });
		expect(store.forget("host.gone12")).toBe(true);
		expect(store.forget("host.gone12")).toBe(false);
		expect(store.getByTeam("host.gone12")).toBeUndefined();
	});
});
