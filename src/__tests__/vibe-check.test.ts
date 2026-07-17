import { describe, expect, it } from "vitest";
import { createVibeCheck } from "../gateway/vibeCheck.js";
import { isPromptEmpty } from "../shared/agent-screen.js";
import { SessionStore } from "../shared/session-store.js";

const RULE = "─".repeat(40);
// The real pane shapes (see AgentScreen.kt / agent-screen.ts): transcript, rule, composer, rule,
// toolbar. Idle toolbar has no esc hint; a working session's does.
const IDLE_EMPTY = `● done\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
const WORKING = `✻ Envisioning… (2m · ↓ 6.9k tokens)\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`;
const IDLE_STAGED = `● done\n${RULE}\n❯ half-typed draft\n${RULE}\n  ⏵⏵ bypass permissions on`;
const RAW_SHELL = "root@host ~ $ ";

function makeHarness() {
	const store = new SessionStore();
	const record = store.adoptById("abc123", { spawn: "proj" });
	if (!record) throw new Error("adopt failed");
	const team = store.teamOf(record);
	const state = {
		screen: IDLE_EMPTY as string | null,
		sent: [] as string[],
		renames: [] as { description: string; dedupKey: string }[],
		leadUp: true,
		now: 1_000,
		renameFails: false,
	};
	let n = 0;
	const vibe = createVibeCheck({
		sessionStore: store,
		resolveLead: () => (state.leadUp ? { send: (p: string) => state.sent.push(p) } : undefined),
		peekScreen: async () => state.screen,
		sendRename: async (_record, description, dedupKey) => {
			if (state.renameFails) throw new Error("host offline");
			state.renames.push({ description, dedupKey });
		},
		now: () => state.now,
		idGen: () => `vc-test${++n}`,
	});
	return { store, record, team, state, vibe };
}

describe("vibeCheck arming", () => {
	it("arms after 3 user messages on a fresh session, and only then", async () => {
		const { vibe, team, state } = makeHarness();
		vibe.noteInbound(team, "user");
		vibe.noteInbound(team, "user");
		await vibe.tick();
		expect(state.sent).toHaveLength(0);
		vibe.noteInbound(team, "user");
		await vibe.tick();
		expect(state.sent).toHaveLength(1);
		const push = JSON.parse(state.sent[0]);
		expect(push.type).toBe("channel_push");
		// NOT "gateway": the MCP role cache auto-answers gateway-authored reply_schema pushes.
		expect(push.from).toBe("vibe-check");
		expect(push.session_id).toMatch(/^vc-/);
		expect(push.replyJsonSchema).toContain("description");
	});

	it("ignores agent messages during the fresh phase", async () => {
		const { vibe, team, state } = makeHarness();
		for (let i = 0; i < 20; i++) vibe.noteInbound(team, "agent");
		await vibe.tick();
		expect(state.sent).toHaveLength(0);
	});

	it("never tracks a team with no session record", async () => {
		const { vibe, state } = makeHarness();
		for (let i = 0; i < 5; i++) vibe.noteInbound("stranger.zzz", "user");
		await vibe.tick();
		expect(state.sent).toHaveLength(0);
	});

	it("re-arms every 10 messages of ANY origin once steady", async () => {
		const { vibe, team, state } = makeHarness();
		for (let i = 0; i < 3; i++) vibe.noteInbound(team, "user");
		await vibe.tick();
		vibe.resolve(JSON.parse(state.sent[0]).session_id, { description: "first answer" });
		// The answered check owes its /rename; flush it so the next send is the check itself.
		await vibe.tick();
		for (let i = 0; i < 9; i++) vibe.noteInbound(team, i % 2 ? "agent" : "user");
		await vibe.tick();
		expect(state.sent).toHaveLength(1);
		vibe.noteInbound(team, "agent");
		await vibe.tick();
		expect(state.sent).toHaveLength(2);
	});
});

describe("vibeCheck idle gating", () => {
	async function armed() {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		return h;
	}

	it("holds while the session is working, then sends at the first idle tick", async () => {
		const h = await armed();
		h.state.screen = WORKING;
		await h.vibe.tick();
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
		h.state.screen = IDLE_EMPTY;
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
	});

	it("holds while the pane has no composer at all (raw shell / booting)", async () => {
		const h = await armed();
		h.state.screen = RAW_SHELL;
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
		h.state.screen = null; // unpeekable (container logs, host offline)
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
	});

	it("holds while the session is asleep or unconfirmed (no lead)", async () => {
		const h = await armed();
		h.state.leadUp = false;
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
		h.state.leadUp = true;
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
	});

	it("sends at most one check while an answer is pending", async () => {
		const h = await armed();
		await h.vibe.tick();
		await h.vibe.tick();
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
	});
});

describe("vibeCheck resolve", () => {
	async function answered(description: unknown, response?: string) {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		await h.vibe.tick();
		const id = JSON.parse(h.state.sent[0]).session_id as string;
		const handled = h.vibe.resolve(
			id,
			typeof description === "string" ? { description } : (description as Record<string, unknown> | undefined),
			response,
		);
		return { ...h, id, handled };
	}

	it("stores the sanitized description on the record", async () => {
		const h = await answered("  Fixing the \n vibe \u200B check tests  ");
		expect(h.handled).toBe(true);
		expect(h.store.getByTeam(h.team)?.description).toBe("Fixing the vibe check tests");
	});

	it("falls back to the prose response when no structured description came", async () => {
		const h = await answered(undefined, "Auditing the console hardening plan");
		expect(h.store.getByTeam(h.team)?.description).toBe("Auditing the console hardening plan");
	});

	it("returns false for a session id it never sent", () => {
		const { vibe } = makeHarness();
		expect(vibe.resolve("vc-never-sent", { description: "x" })).toBe(false);
	});

	it("survives a snapshot/restore round trip", async () => {
		const h = await answered("Persisted phrase");
		const reloaded = new SessionStore();
		reloaded.restore(h.store.snapshot());
		expect(reloaded.getByTeam(h.team)?.description).toBe("Persisted phrase");
	});
});

describe("vibeCheck rename follow-through", () => {
	async function afterAnswer() {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		await h.vibe.tick();
		const id = JSON.parse(h.state.sent[0]).session_id as string;
		h.vibe.resolve(id, { description: "Console hardening audit" });
		return { ...h, id };
	}

	it("types /rename at the next idle tick, keyed by the answered check's id", async () => {
		const h = await afterAnswer();
		await h.vibe.tick();
		expect(h.state.renames).toEqual([{ description: "Console hardening audit", dedupKey: h.id }]);
		// Once only - the follow-through clears.
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(1);
	});

	it("waits out a working pane and a staged composer draft before typing", async () => {
		const h = await afterAnswer();
		h.state.screen = WORKING;
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(0);
		h.state.screen = IDLE_STAGED;
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(0);
		h.state.screen = IDLE_EMPTY;
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(1);
	});

	it("keeps the rename pending across a transient send failure", async () => {
		const h = await afterAnswer();
		h.state.renameFails = true;
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(0);
		h.state.renameFails = false;
		await h.vibe.tick();
		expect(h.state.renames).toHaveLength(1);
	});
});

describe("vibeCheck lifecycle", () => {
	it("expires an ignored check and waits out a whole steady threshold", async () => {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
		h.state.now += 10 * 60_000;
		await h.vibe.tick();
		// Expired, settled to steady: 9 messages do nothing, the 10th re-arms.
		for (let i = 0; i < 9; i++) h.vibe.noteInbound(h.team, "agent");
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
		h.vibe.noteInbound(h.team, "agent");
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(2);
	});

	it("resets to the fresh phase when the team goes offline", async () => {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		h.vibe.noteOffline(h.team);
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
		// Fresh again: agent messages don't count, three user messages do.
		for (let i = 0; i < 10; i++) h.vibe.noteInbound(h.team, "agent");
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(1);
	});

	it("drops all state when the record is forgotten", async () => {
		const h = makeHarness();
		for (let i = 0; i < 3; i++) h.vibe.noteInbound(h.team, "user");
		h.store.forget(h.team);
		await h.vibe.tick();
		expect(h.state.sent).toHaveLength(0);
	});
});

describe("agent-screen isPromptEmpty", () => {
	it("is true only for a bare composer box", () => {
		expect(isPromptEmpty(IDLE_EMPTY)).toBe(true);
		expect(isPromptEmpty(IDLE_STAGED)).toBe(false);
	});

	it("ignores past slash-command echoes in the transcript above the box", () => {
		const screen = `❯ /model\n  ⎿  Kept model as Sonnet 5\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on`;
		expect(isPromptEmpty(screen)).toBe(true);
	});

	it("is false without a bounded composer box", () => {
		expect(isPromptEmpty(RAW_SHELL)).toBe(false);
		expect(isPromptEmpty(`❯ \n${RULE}\n  toolbar only`)).toBe(false);
		expect(isPromptEmpty("")).toBe(false);
	});

	it("strips SGR escapes around the rules and prompt", () => {
		const esc = String.fromCharCode(27);
		const screen = `${esc}[2m${RULE}${esc}[0m\n${esc}[39m❯ ${esc}[0m\n${esc}[2m${RULE}${esc}[0m\n  ⏵⏵`;
		expect(isPromptEmpty(screen)).toBe(true);
	});
});
