import { describe, expect, it } from "vitest";
import { CopilotPersistedAgentSchema, copilotOperationFingerprint } from "../shared/copilot-agent.js";
import { sanitizeLabel, sanitizeWorkdirPath } from "../shared/session-sanitize.js";
import { type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

// Scripted ids, then unique fillers.
function scriptedIds(...ids: string[]) {
	let extra = 0;
	return () => ids.shift() ?? `fill${extra++}`;
}

const LEGACY_FILE = {
	"host.switchboard": { claudeSessionId: "16aa1d0d-aaaa", lastSeen: 1000 },
	"host.story-telling": { claudeSessionId: "c1fa7689-bbbb", lastSeen: 2000 },
};

const COPILOT_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const COPILOT_AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

function requestedCopilotAgent() {
	return CopilotPersistedAgentSchema.parse({
		version: 1,
		agentId: COPILOT_AGENT_ID,
		agentState: "creating",
		requestedTarget: { kind: "host", workdirHint: "Work" },
		operations: [
			{
				operationId: COPILOT_OPERATION_ID,
				kind: "start",
				prompt: "Review",
				fingerprint: copilotOperationFingerprint("start", COPILOT_AGENT_ID, "Review\nauto"),
				state: "requested",
				createdAt: 10,
				updatedAt: 10,
			},
		],
		turns: [],
		createdAt: 10,
		updatedAt: 10,
	});
}

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

	it("findByMintedFrom finds a gateway-minted record by its own provenance, scoped to a spawn", () => {
		const store = new SessionStore({ idGen: scriptedIds("minted1") });
		const rec = store.mint({ spawn: "host", sessionLabel: "Work", mintedFrom: "conv:op1" });
		expect(store.findByMintedFrom("conv:op1", "host")).toBe(rec);
		expect(store.findByMintedFrom("conv:op1", "other-spawn")).toBeUndefined();
		expect(store.findByMintedFrom("conv:unrelated", "host")).toBeUndefined();
	});

	it("findByMintedFrom refuses to trust an ambiguous match rather than pick either record", () => {
		const store = new SessionStore({ idGen: scriptedIds("dup-a", "dup-b") });
		store.mint({ spawn: "host", sessionLabel: "A", mintedFrom: "conv:op1" });
		store.mint({ spawn: "host", sessionLabel: "B", mintedFrom: "conv:op1" });
		expect(store.findByMintedFrom("conv:op1", "host")).toBeUndefined();
	});

	it("findByMintedFrom still resolves a record after it has been renamed", () => {
		const store = new SessionStore({ idGen: scriptedIds("minted1") });
		const rec = store.mint({ spawn: "host", sessionLabel: "Work", mintedFrom: "conv:op1" });
		store.rename("host.minted1", "Renamed");
		expect(store.findByMintedFrom("conv:op1", "host")).toBe(rec);
		expect(rec.sessionLabel).toBe("Renamed");
	});

	it("mintOrReattach mints fresh on a first call, then reattaches the SAME record for a retry sharing the same provenance", () => {
		const store = new SessionStore({ idGen: scriptedIds("minted1", "minted2") });
		const first = store.mintOrReattach({ spawn: "host", sessionLabel: "Work", mintedFrom: "conv:op1" });
		expect(first).toMatchObject({ created: true, record: { id: "minted1", sessionLabel: "Work" } });
		// A retry with the same provenance reattaches - a fresh mintOpts.sessionLabel is ignored, the
		// established record's own label wins, same precedent as adoptOrReattach's reattach path.
		const retry = store.mintOrReattach({ spawn: "host", sessionLabel: "ignored", mintedFrom: "conv:op1" });
		expect(retry).toMatchObject({ created: false, record: { id: "minted1", sessionLabel: "Work" } });
		expect(store.size).toBe(1);
		// A DIFFERENT provenance under the same spawn mints its own, separate record.
		const other = store.mintOrReattach({ spawn: "host", sessionLabel: "Other", mintedFrom: "conv:op2" });
		expect(other).toMatchObject({ created: true, record: { id: "minted2", sessionLabel: "Other" } });
		expect(store.size).toBe(2);
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

describe("SessionStore labels and paths", () => {
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

	it("sanitizes labels into usable session state", () => {
		const inputs = [
			"  My Cool Session!  ",
			"chat \u{1F600}",
			"a/b",
			"a\\b",
			"..",
			"tab\there",
			"\u200b\u200b\u200b",
			"abc\u202edef",
			"x\u0085y",
			"",
			"x".repeat(200),
			`${"x".repeat(63)}\u{1F600}`,
		];
		expect(inputs.map(sanitizeLabel)).toEqual([
			"My Cool Session!",
			"chat \u{1F600}",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			"x".repeat(64),
			`${"x".repeat(63)}\u{1F600}`,
		]);
	});

	it("mint falls back to safe defaults when the supplied label and hint are unsafe", () => {
		const store = new SessionStore({ idGen: scriptedIds("safe01") });
		const rec = store.mint({ spawn: "host", sessionLabel: "../evil", workdirHint: "a/b" });
		expect(rec.sessionLabel).toBe("safe01");
		expect(rec.workdirHint).toBeUndefined();
	});

	it("hostWorkdirHint pins the workdir to the original label across a rename, else falls back to the label", () => {
		const store = new SessionStore({ idGen: scriptedIds("id1", "id2") });
		const rec = store.mint({ spawn: "host", sessionLabel: "app", workdirHint: "app" });
		store.rename("host.id1", "renamed"); // rename mutates only the label
		expect(rec.sessionLabel).toBe("renamed");
		expect(store.hostWorkdirHint(rec)).toBe("app"); // workdir stays pinned to the original
		const bare = store.mint({ spawn: "host", sessionLabel: "solo" });
		expect(bare.workdirHint).toBeUndefined();
		expect(store.hostWorkdirHint(bare)).toBe("solo"); // no hint -> current label
	});

	it("a picked workdirPath wins hostWorkdirHint over the label hint and survives a restore", () => {
		const store = new SessionStore({ idGen: scriptedIds("id1") });
		const rec = store.mint({ spawn: "host", sessionLabel: "app", workdirHint: "app", workdirPath: "~/deep/dir" });
		expect(store.hostWorkdirHint(rec)).toBe("~/deep/dir");

		const next = new SessionStore();
		next.restore(store.snapshot());
		const loaded = next.getByTeam("host.id1");
		expect(loaded?.workdirPath).toBe("~/deep/dir");
		expect(next.hostWorkdirHint(loaded as NonNullable<typeof loaded>)).toBe("~/deep/dir");
	});

	it("sanitizes workdir paths into safe persisted state", () => {
		const inputs = [
			"/data/media",
			"  ~/projects/app  ",
			"~",
			"relative/dir",
			"~elsewhere",
			"/it's",
			'/a"b',
			"/a`b",
			"/a$b",
			"/a\\b",
			`/${"x".repeat(600)}`,
			"",
		];
		expect(inputs.map(sanitizeWorkdirPath)).toEqual([
			"/data/media",
			"~/projects/app",
			"~",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	it("restore drops a hand-edited workdirPath that fails the path rules", () => {
		const store = new SessionStore();
		store.restore({
			"host.abc123": { id: "abc123", sessionLabel: "app", spawn: "host", workdirPath: "$(pwn)", lastSeen: 1 },
		});
		expect(store.getByTeam("host.abc123")?.workdirPath).toBeUndefined();
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
		expect(store.sweep(50)).toEqual(["host.stale1"]); // names exactly what it removed
		expect(store.getByTeam("host.live01")).toBeDefined();
		expect(store.getByTeam("host.stale1")).toBeUndefined();
	});

	it("sweep returns nothing when nothing was old enough to remove", () => {
		let clock = 0;
		const store = new SessionStore({ now: () => clock, idGen: scriptedIds("fresh1") });
		store.mint({ spawn: "host", sessionLabel: "fresh" });
		clock = 10;
		expect(store.sweep(1_000)).toEqual([]);
		expect(store.getByTeam("host.fresh1")).toBeDefined();
	});

	it("evicts least-recently-seen down to the cap, keeping live records past it", () => {
		let clock = 0;
		const store = new SessionStore({
			now: () => clock,
			idGen: scriptedIds("oldest", "middle", "newest", "livest"),
		});
		for (const label of ["oldest", "middle", "newest", "livest"]) {
			store.mint({ spawn: "host", sessionLabel: label });
			clock += 10;
		}
		store.touchLive("host.livest");

		const removed = store.sweep(1_000_000, { maxEntries: 2, isLive: (team) => team === "host.oldest" });

		// Live is skipped even though it is the least recently seen, so the next-oldest goes instead.
		expect(removed).toEqual(["host.middle", "host.newest"]);
		expect(store.getByTeam("host.oldest")).toBeDefined();
		expect(store.getByTeam("host.livest")).toBeDefined();
	});

	it("leaves the cap alone when the store is within it", () => {
		const store = new SessionStore({ now: () => 0, idGen: scriptedIds("only01") });
		store.mint({ spawn: "host", sessionLabel: "only" });
		expect(store.sweep(1_000, { maxEntries: 8, isLive: () => false })).toEqual([]);
		expect(store.getByTeam("host.only01")).toBeDefined();
	});

	it("keeps every record when the cap cannot be met without evicting a live one", () => {
		const store = new SessionStore({ now: () => 0, idGen: scriptedIds("live001", "live002") });
		store.mint({ spawn: "host", sessionLabel: "one" });
		store.mint({ spawn: "host", sessionLabel: "two" });
		expect(store.sweep(1_000, { maxEntries: 1, isLive: () => true })).toEqual([]);
		expect(store.list()).toHaveLength(2);
	});

	it("forget removes the record and returns whether it existed", () => {
		const store = new SessionStore({ idGen: scriptedIds("gone12") });
		store.mint({ spawn: "host" });
		expect(store.forget("host.gone12")).toBe(true);
		expect(store.forget("host.gone12")).toBe(false);
		expect(store.getByTeam("host.gone12")).toBeUndefined();
	});
});

describe("SessionStore session binding", () => {
	it("creates a token only when a launched session needs one", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });

		expect(record.bindToken).toBeUndefined();
		const first = store.ensureBindToken(record);
		expect(store.ensureBindToken(record)).toBe(first);
		expect(store.recordByBindToken(first)).toEqual(record);
		expect(store.recordByBindToken("not-a-real-token")).toBeUndefined();
	});

	it("restores the binding for its owner and leaves tokenless records tokenless", () => {
		const store = new SessionStore();
		const record = store.mint({ spawn: "recipe-app" });
		const token = store.ensureBindToken(record);
		store.mint({ spawn: "recipe-app" });

		const restored = new SessionStore();
		restored.restore(JSON.parse(JSON.stringify(store.snapshot())));

		expect(restored.recordByBindToken(token)?.id).toBe(record.id);
		expect(restored.list().filter((item) => !item.bindToken)).toHaveLength(1);
	});
});

describe("SessionStore Copilot catalogs", () => {
	it("commits an agent, snapshots it, and restores it under its session", () => {
		let writer!: CopilotCatalogWriter;
		const store = new SessionStore({
			copilotCatalogPersistence: {
				persistChecked: () => {},
				receiveWriter: (received) => {
					writer = received;
				},
			},
		});
		const owner = store.mint({ spawn: "host", sessionLabel: "Work" });
		const agent = requestedCopilotAgent();

		const result = writer.commit(owner, 0, [agent]);
		const restored = new SessionStore();
		restored.restore(store.snapshot());
		const restoredOwner = restored.getByTeam(store.teamOf(owner));

		expect(result).toMatchObject({ committed: true, catalog: { revision: 1, agents: [agent] } });
		expect(restored.listCopilotAgents(restoredOwner!)).toEqual([agent]);
	});

	it("restores healthy Copilot agents while dropping a damaged sibling", () => {
		const healthy = requestedCopilotAgent();
		const store = new SessionStore();

		store.restore({
			"host.owner": {
				id: "owner",
				sessionLabel: "Owner",
				spawn: "host",
				lastSeen: 10,
				copilotCatalog: { version: 1, revision: 7, agents: [healthy, { broken: true }] },
			},
		});

		const owner = store.getByTeam("host.owner");
		expect(store.copilotCatalog(owner!)).toEqual({ version: 1, revision: 7, agents: [healthy] });
	});
});
