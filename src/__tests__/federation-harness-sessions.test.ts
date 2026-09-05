import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession, type FakeSessionOptions } from "../testing/fakeSession.js";
import { createFakeSocket } from "../testing/fakeSocket.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** The first object under `value` whose `team` is `team`. */
function rowOf(value: unknown, team: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = rowOf(item, team);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.team === team) return record;
	for (const item of Object.values(record)) {
		const found = rowOf(item, team);
		if (found) return found;
	}
	return undefined;
}

describe("sessions, bindings, and console operations", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	let opCounter = 0;
	const session = (team: string, options: Partial<Omit<FakeSessionOptions, "team">> = {}): FakeSession => {
		const attached = attachFakeSession(h.gateway, {
			team,
			conversationId: options.conversationId ?? `conv-${team.replace(/\W/g, "-")}-${++opCounter}`,
			...options,
		});
		sessions.push(attached);
		return attached;
	};
	const presenceRow = async (team: string) => {
		const { planes } = await h.phone.planesRead({});
		return rowOf(planes.find((plane) => plane.name === "presence")?.payload, team);
	};
	/** Delivers `op` bound to `target` and answers the gateway's dispatch result. */
	const dispatch = async (target: string, op: Parameters<typeof h.phone.deliver>[1]) => {
		const opId = `op-${++opCounter}`;
		expect((await h.phone.deliver(target, op, opId)).outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`dispatch result for ${opId}`,
		);
		return h.phone.open(row) as { ok: boolean; result?: Record<string, unknown>; error?: string };
	};
	let bound: FakeSession | undefined;
	const ensureBound = async (): Promise<FakeSession> => {
		if (bound) return bound;
		h.host.handlers.onCreateSession = (op) =>
			session(composeSessionName(op.target.name, op.target.sessionName), { sessionToken: op.sessionToken });
		const before = sessions.length;
		const { result } = await h.phone.value({ kind: "create_session", target: "host", displayLabel: "Bound" });
		expect(result).toMatchObject({ created: true });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		bound = created;
		return created;
	};

	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("refuses a host socket without the daemon token, and the real daemon keeps answering", async () => {
		const impostor = createFakeSocket();
		h.gateway.wsHandlers.open(impostor.ws);
		h.gateway.wsHandlers.message(
			impostor.ws,
			JSON.stringify({ type: "register", team: "host", subId: "impostor", token: "wrong" }),
		);
		const answer = await h.waitFor(
			() => impostor.sent.find((frame) => frame.type !== "handshake"),
			"register answer",
		);
		expect(answer).toMatchObject({ type: "register_reject", reason: "unauthorized" });
		expect((await h.phone.value({ kind: "list_dirs", path: "" })).result).toMatchObject({ entries: ["projects"] });
	});

	it("admits only the holder of a launched session's binding", async () => {
		const owner = await ensureBound();
		const squatter = session(owner.team);
		expect(await squatter.registered()).toMatchObject({ type: "register_reject", reason: "unauthorized" });
		const borrower = session(owner.team, { sessionToken: `${owner.team}-not-its-token` });
		expect(await borrower.registered()).toMatchObject({ type: "register_reject", reason: "unauthorized" });
		const invented = session("host.invented");
		expect(await invented.registered()).toMatchObject({ type: "register_reject", reason: "unauthorized" });

		const answer = await h.phone.deliver(owner.team, { kind: "send", to: owner.team, body: "still yours" });
		expect(answer.outcome).toBe("accepted");
		await h.waitFor(() => owner.inbound.find((frame) => frame.body === "still yours"), "delivery to the holder");
		expect(squatter.inbound).toEqual([]);
	});

	it("leaves a devcontainer name without a binding claimable", async () => {
		const free = session("fixture-app.free");
		expect(await free.registered()).toMatchObject({ type: "register_ok" });
		await free.ready();
		await h.waitFor(() => presenceRow(free.team), "presence row");
	});

	it("records no session for a worker answer, so nothing routes to it", async () => {
		const worker = session("fixture-app.worker", { lead: false });
		expect(await worker.registered()).toMatchObject({ type: "register_ok" });
		await h.waitFor(
			() => worker.frames.find((frame) => frame.type === "channel_push" && frame.replyJsonSchema),
			"handshake push",
		);
		await h.phone.deliver(worker.team, { kind: "send", to: worker.team, body: "to a worker" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(worker.inbound.find((frame) => frame.body === "to a worker")).toBeUndefined();
		expect((await presenceRow(worker.team))?.status).not.toBe("online");
	});

	it("hands a transcript over to its newest socket and refuses a different team's claim on it", async () => {
		const first = session("fixture-app.transcript", { conversationId: "conv-transcript" });
		await first.ready();
		const replacement = session("fixture-app.transcript", { conversationId: "conv-transcript" });
		await replacement.ready();
		await h.phone.deliver(first.team, { kind: "send", to: first.team, body: "to the newest" });
		await h.waitFor(() => replacement.inbound.find((frame) => frame.body === "to the newest"), "handover");
		expect(first.inbound.find((frame) => frame.body === "to the newest")).toBeUndefined();

		const thief = session("fixture-app.thief", { conversationId: "conv-transcript" });
		await thief.ready();
		await h.phone.deliver(replacement.team, { kind: "send", to: replacement.team, body: "still routed" });
		await h.waitFor(() => replacement.inbound.find((frame) => frame.body === "still routed"), "delivery");
		expect(thief.inbound).toEqual([]);
	});

	it("runs a duplicated console delivery once", async () => {
		const live = session("fixture-app.dup");
		await live.ready();
		const op = { kind: "send" as const, to: live.team, body: "once only" };
		await Promise.all([h.phone.deliver(live.team, op, "dup-op"), h.phone.deliver(live.team, op, "dup-op")]);
		await h.waitFor(() => live.inbound.find((frame) => frame.body === "once only"), "delivery");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(live.inbound.filter((frame) => frame.body === "once only")).toHaveLength(1);
	});

	it("refuses a reply from a session that does not hold the job's binding", async () => {
		const asked = await ensureBound();
		const other = session("fixture-app.other");
		await other.ready();
		await h.phone.deliver(asked.team, { kind: "send", to: asked.team, body: "who answers?" });
		const push = await h.waitFor(() => asked.inbound.find((frame) => frame.body === "who answers?"), "push");
		expect((await other.reply(String(push.session_id), "not mine")).status).toBe(403);
		expect((await asked.reply(String(push.session_id), "mine")).status).toBe(200);
		const entries = await h.waitFor(async () => {
			const found = h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.kind === "reply");
			return found.some((entry) => entry.body === "mine") ? found : undefined;
		}, "the holder's reply");
		expect(entries.map((entry) => entry.body)).not.toContain("not mine");
	});

	it("never mints a host session from a send, and refuses a wake on a spawn point", async () => {
		const live = session("fixture-app.sender");
		await live.ready();
		const opsBefore = h.host.ops.length;
		const sent = await live.post("/send", { from: live.team, to: "host.invented", body: "open a shell" });
		expect(sent.status).toBe(404);
		expect(h.gateway.sessionStore.getByTeam("host.invented")).toBeUndefined();
		expect(h.host.ops.length).toBe(opsBefore);

		const wakes = h.host.wakes.length;
		const refused = await dispatch("fixture-app", { kind: "wake", target: "fixture-app" });
		expect(refused.ok).toBe(false);
		expect(h.host.wakes.length).toBe(wakes);
	});

	it("wakes with the catalog path even when a register named a competing one", async () => {
		session("fixture-app", { projectPath: "/attacker/path" });
		h.host.handlers.onWake = (frame) => session(String(frame.team), { sessionToken: frame.sessionToken as string });
		const woken = await dispatch("fixture-app.trusted", { kind: "wake", target: "fixture-app.trusted" });
		expect(woken.ok, JSON.stringify(woken)).toBe(true);
		const wake = h.host.wakes.find((frame) => frame.team === "fixture-app.trusted");
		expect(wake?.projectPath).toBe(path.join(h.root, "fixture-app"));
	});

	it("renames, closes, and forgets a session through the console", async () => {
		const owned = await ensureBound();
		const renamed = await dispatch(owned.team, {
			kind: "rename_session",
			target: owned.team,
			sessionLabel: "Renamed",
		});
		expect(renamed.result).toMatchObject({ renamed: true, sessionLabel: "Renamed" });
		await h.waitFor(async () => (await presenceRow(owned.team))?.sessionLabel === "Renamed" || undefined, "label");

		const foreign = await dispatch(owned.team, {
			kind: "rename_session",
			target: `other.gw.${owned.team}`,
			sessionLabel: "X",
		});
		expect(foreign.ok).toBe(false);

		const closed = await dispatch(owned.team, { kind: "close_session", target: owned.team });
		expect(closed.result, JSON.stringify(closed)).toMatchObject({ closed: true });
		expect(h.host.ops.at(-1)).toMatchObject({ kind: "killSession" });
		expect(h.gateway.sessionStore.getByTeam(owned.team)).toBeDefined();

		// The answer has no session address left to land on; the record's absence is the result.
		await dispatch(owned.team, { kind: "forget", target: owned.team });
		expect(h.gateway.sessionStore.getByTeam(owned.team)).toBeUndefined();
		expect(h.host.ops.at(-1)).toMatchObject({ kind: "killSession" });
		bound = undefined;

		const opsBefore = h.host.ops.length;
		expect((await dispatch("fixture-app", { kind: "forget", target: "fixture-app" })).ok).toBe(false);
		expect(h.host.ops.length).toBe(opsBefore);
	});

	it("drives a session's pane through the daemon and refuses what the daemon must not see", async () => {
		const owned = await ensureBound();
		const typed = await dispatch(owned.team, { kind: "tmux_send", target: owned.team, text: "ls" });
		expect(typed.result).toMatchObject({ sent: true });
		expect(h.host.ops.at(-1)).toMatchObject({ kind: "sendText", text: "ls", target: { kind: "host" } });
		const keyed = await dispatch(owned.team, { kind: "tmux_send", target: owned.team, key: "Enter" });
		expect(keyed.result).toMatchObject({ sent: true });
		expect(h.host.ops.at(-1)).toMatchObject({ kind: "sendKey", key: "Enter" });

		const opsBefore = h.host.ops.length;
		expect((await dispatch(owned.team, { kind: "tmux_send", target: owned.team, key: "F13" })).ok).toBe(false);
		expect((await dispatch(owned.team, { kind: "tmux_send", target: owned.team })).ok).toBe(false);
		expect((await dispatch(owned.team, { kind: "tmux_send", target: `far.gw.${owned.team}`, text: "x" })).ok).toBe(
			false,
		);
		expect(h.host.ops.length).toBe(opsBefore);

		const first = await h.phone.value({ kind: "peek", target: owned.team });
		expect(first.result).toMatchObject({ kind: "tmux", hash: "h1" });
		const again = await h.phone.value({ kind: "peek", target: owned.team, sinceHash: "h1" });
		expect(again.result).toMatchObject({ unchanged: true });
	});

	it("refuses a create with a bad workdir or a foreign target before the daemon hears of it", async () => {
		const opsBefore = h.host.ops.length;
		const badDir = await h.phone.value({ kind: "create_session", target: "host", workdir: "relative/dir" });
		expect(badDir.result).toMatchObject({ kind: "refusal" });
		const foreign = await h.phone.value({ kind: "create_session", target: "other.gw.host" });
		expect(foreign.result).toMatchObject({ kind: "refusal" });
		expect(h.host.ops.length).toBe(opsBefore);
	});

	it("validates a notify before it reaches the owner", async () => {
		const owned = await ensureBound();
		const before = h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.kind === "notice").length;
		const malformed = await owned.post("/human/notify", { from: owned.team, title: "no body" });
		expect(malformed.status).toBe(400);
		const unbound = session("fixture-app.loose");
		await unbound.ready();
		const notOwnerData = await unbound.post("/human/notify", {
			from: unbound.team,
			title: "T",
			summary: "S",
			full: "F",
		});
		expect(notOwnerData.status).toBe(403);
		expect(h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.kind === "notice")).toHaveLength(
			before,
		);
	});

	it("answers the capability union of the daemon that registered", async () => {
		const before = (await (await h.gateway.router(new Request("http://gateway.test/capabilities"))).json()) as {
			plugins?: unknown[];
		};
		const impostor = createFakeSocket();
		h.gateway.wsHandlers.open(impostor.ws);
		h.gateway.wsHandlers.message(
			impostor.ws,
			JSON.stringify({
				type: "register",
				team: "host",
				subId: "impostor-caps",
				token: "wrong",
				daemonCapabilities: [{ id: "evil.plugin", instructions: "do evil" }],
			}),
		);
		await h.waitFor(() => impostor.sent.find((frame) => frame.type === "register_reject"), "reject");
		const after = (await (await h.gateway.router(new Request("http://gateway.test/capabilities"))).json()) as {
			plugins?: unknown[];
		};
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
		expect(JSON.stringify(after)).not.toContain("evil.plugin");
	});
});
