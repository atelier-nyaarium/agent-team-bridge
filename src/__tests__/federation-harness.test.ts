import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rankBetween } from "../shared/board-rank.js";
import { BOARD_TITLE_KIND, boardTextAadKind, wrapContentKey } from "../shared/content-envelope.js";
import type { KeyRequest } from "../shared/schemasContentKey.js";
import { InboxRowSchema } from "../shared/schemasInbox.js";
import { composeSessionName } from "../shared/session-id.js";
import { type ConsoleSocket, openConsoleSocket } from "../testing/consoleSocket.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { contentKeyOf } from "../testing/identitySet.js";

/** Whether any string leaf of `value` names `needle`. */
function carries(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (Array.isArray(value)) return value.some((item) => carries(item, needle));
	if (value && typeof value === "object") return Object.values(value).some((item) => carries(item, needle));
	return false;
}

describe("federation harness", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	const sockets: ConsoleSocket[] = [];
	const session = (team: string, sessionToken?: string): FakeSession => {
		const conversationId = `conv-${team.replace(/[^a-zA-Z0-9]/g, "-")}`;
		const attached = attachFakeSession(h.gateway, { team, conversationId, sessionToken });
		sessions.push(attached);
		return attached;
	};
	const consoleSocket = async (planesOnly = false): Promise<ConsoleSocket> => {
		const socket = await openConsoleSocket({
			port: h.router.port,
			token: h.set.tokens.console,
			hello: h.phone.ownerOp({ kind: "hello" }),
			planesOnly,
		});
		sockets.push(socket);
		await h.waitFor(() => socket.frames.find((frame) => frame.type === "welcome"), "welcome frame");
		return socket;
	};
	// Lazily shared across tests.
	let liveSession: FakeSession | undefined;
	const ensureLive = async (): Promise<FakeSession> => {
		if (liveSession) return liveSession;
		liveSession = session("fixture-app.abc123");
		await liveSession.ready();
		return liveSession;
	};
	let boundSession: FakeSession | undefined;
	const ensureBound = async (): Promise<FakeSession> => {
		if (boundSession) return boundSession;
		h.host.handlers.onCreateSession = (op) =>
			session(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		const before = sessions.length;
		const { envelope, result } = await h.phone.value({
			kind: "create_session",
			target: "host",
			displayLabel: "Scratch",
		});
		expect(envelope.outcome).toBe("accepted");
		expect(result).toMatchObject({ created: true });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		boundSession = created;
		return created;
	};
	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		for (const socket of sockets) await socket.close();
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("answers a phone list_dirs through the gateway and the host daemon", async () => {
		const { envelope, result } = await h.phone.value({ kind: "list_dirs", path: "" });
		expect(envelope.outcome).toBe("accepted");
		expect(result).toMatchObject({ entries: ["projects"] });
	});

	it("answers an unknown path with 404 through handle", async () => {
		expect((await h.router.server.handle(new Request("https://router.test/nowhere"))).status).toBe(404);
	});

	it("delivers a phone send to a live session and lands the reply in the owner mailbox", async () => {
		const live = await ensureLive();

		const answer = await h.phone.deliver(live.team, { kind: "send", to: live.team, body: "status?" });
		expect(answer.outcome).toBe("accepted");

		const push = await h.waitFor(() => live.inbound.find((frame) => frame.body === "status?"), "channel push");
		expect((await live.reply(String(push.session_id), "all green")).status).toBe(200);

		const reply = await h.waitFor(async () => {
			const entries = h.phone.entries(await h.phone.inboxRead());
			return entries.find((entry) => entry.kind === "reply" && entry.body === "all green");
		}, "owner reply row");
		expect(reply.kind).toBe("reply");
	});

	it("creates a host session the daemon launches, then takes its bound notify_human", async () => {
		const created = await ensureBound();

		const notified = await created.post("/human/notify", {
			from: created.team,
			title: "Build done",
			summary: "The build finished green.",
			full: "The build finished green on the first try.",
		});
		expect(notified.status).toBe(200);
		const notice = await h.waitFor(async () => {
			const entries = h.phone.entries(await h.phone.inboxRead());
			return entries.find((entry) => entry.kind === "notice" && entry.title === "Build done");
		}, "owner notice row");
		expect(notice.from).toContain(created.team);
	});

	it("projects live sessions onto the presence plane the phone reads", async () => {
		const live = await ensureLive();
		const projection = await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead({});
			const presence = planes.find((plane) => plane.name === "presence");
			return presence && carries(presence.payload, live.team) ? presence : undefined;
		}, "presence projection carrying the session");
		expect(carries(projection.payload, live.team)).toBe(true);
	});

	it("wakes a sleeping devcontainer session for a phone send", async () => {
		h.host.handlers.onWake = (frame) => session(String(frame.team), frame.sessionToken as string | undefined);
		const created = await h.phone.value({ kind: "create_session", target: "fixture-app", displayLabel: "Woken" });
		expect(created.result, JSON.stringify(created.result)).toMatchObject({ created: true });
		const woken = sessions.at(-1);
		if (!woken) throw new Error("the daemon was never asked to wake");
		await woken.ready();

		woken.close();
		const asleepAnswer = await h.phone.deliver(woken.team, { kind: "send", to: woken.team, body: "wake up" });
		expect(asleepAnswer.outcome).toBe("accepted");
		const rewoken = await h.waitFor(() => sessions.find((s) => s !== woken && s.team === woken.team), "re-wake");
		const push = await h.waitFor(
			() => rewoken.inbound.find((frame) => frame.body === "wake up"),
			"delivery after wake",
		);
		expect(push.from).toBeDefined();
	});

	it("writes a board entry from the phone and rides its awareness onto the session's next push", async () => {
		const live = await ensureLive();
		const id = "t-phone";
		const written = await h.phone.send({
			kind: "board_write",
			write: {
				expectedRevision: (await h.phone.boardRead()).revision,
				ops: [
					{
						kind: "upsert",
						id,
						state: "open",
						rank: rankBetween(undefined, undefined),
						title: h.phone.seal("Wire the phone", boardTextAadKind(BOARD_TITLE_KIND, id)),
						session: { domainId: h.set.domain.id, gatewayId: h.set.gateway.id, sessionId: live.team },
					},
				],
			},
		});
		expect(written).toMatchObject({ outcome: "applied" });

		const board = await h.phone.boardRead();
		const stored = board.entries.find((entry) => entry.clear.id === id);
		if (!stored) throw new Error("the entry never reached the board");
		expect(h.phone.openText(stored.sealed.title, boardTextAadKind(BOARD_TITLE_KIND, id))).toBe("Wire the phone");

		await h.phone.deliver(live.team, { kind: "send", to: live.team, body: "anything new?" });
		const push = await h.waitFor(
			() => live.inbound.find((frame) => frame.body === "anything new?" && frame.awareness !== undefined),
			"push carrying board awareness",
		);
		expect(JSON.stringify(push.awareness)).toContain("Wire the phone");
	});

	it("lets a bound session create a board entry the phone then reads", async () => {
		const bound = await ensureBound();
		const created = await bound.post("/task-board", {
			from: bound.team,
			action: "create",
			operationId: "board-op-1",
			assignTo: "self",
			title: "From the session",
		});
		expect(created.status).toBe(200);
		const titles = (await h.phone.boardRead()).entries.map((entry) =>
			h.phone.openText(entry.sealed.title, boardTextAadKind(BOARD_TITLE_KIND, entry.clear.id)),
		);
		expect(titles).toContain("From the session");
	});

	it("pushes the presence plane to a console socket when a session registers", async () => {
		const socket = await consoleSocket(true);
		const pushed = session("fixture-app.pushed");
		await pushed.ready();
		const plane = await h.waitFor(
			() =>
				socket.frames.find(
					(frame) =>
						frame.type === "plane" && frame.name === "presence" && carries(frame.payload, pushed.team),
				),
			"presence plane push",
		);
		expect(plane.version).toBeGreaterThan(0);
	});

	it("peeks a session's screen through the host daemon", async () => {
		const live = await ensureLive();
		const { envelope, result } = await h.phone.value({ kind: "peek", target: live.team });
		expect(envelope.outcome).toBe("accepted");
		expect(result).toMatchObject({ kind: "tmux" });
	});

	it("moves a closed session off its live presence row", async () => {
		const gone = session("fixture-app.gone");
		await gone.ready();
		const presenceRow = async () => {
			const { planes } = await h.phone.planesRead({});
			return rowOf(planes.find((plane) => plane.name === "presence")?.payload, gone.team);
		};
		const live = await h.waitFor(presenceRow, "live presence row");
		gone.close();
		await h.waitFor(async () => {
			const row = await presenceRow();
			return row === undefined || row.status !== live.status;
		}, "presence row after close");
	});

	it("pushes a session's notify_human to a console socket", async () => {
		const bound = await ensureBound();
		const socket = await consoleSocket();
		const notified = await bound.post("/human/notify", {
			from: bound.team,
			title: "Socket done",
			summary: "The socket saw it.",
			full: "The socket saw the notice land.",
		});
		expect(notified.status).toBe(200);
		const notice = await h.waitFor(
			() =>
				socket.frames
					.filter((frame) => frame.type === "inbox_rows")
					.flatMap((frame) =>
						h.phone.entries((frame.rows as unknown[]).map((row) => InboxRowSchema.parse(row))),
					)
					.find((entry) => entry.kind === "notice" && entry.title === "Socket done"),
			"notice pushed over the socket",
		);
		expect(notice.from).toContain(bound.team);
	});

	// The restart drops earlier sessions.
	it("drains a reply queued while the Router link was down once the gateway restarts", async () => {
		const late = session("fixture-app.late");
		await late.ready();
		await h.phone.deliver(late.team, { kind: "send", to: late.team, body: "ping" });
		const push = await h.waitFor(() => late.inbound.find((frame) => frame.body === "ping"), "channel push");

		h.gateway.federation()?.routerClient.stop();
		expect((await late.reply(String(push.session_id), "pong")).status).toBe(200);

		await h.restartGateway();
		const reply = await h.waitFor(
			async () => h.phone.entries(await h.phone.inboxRead()).find((entry) => entry.body === "pong"),
			"late reply after restart",
			20_000,
		);
		expect(reply.kind).toBe("reply");
	});
});

/** The first object under `value` whose `team` is `team`. */
function rowOf(value: unknown, team: string): { status?: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = rowOf(item, team);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.team === team) return record as { status?: string };
	for (const item of Object.values(record)) {
		const found = rowOf(item, team);
		if (found) return found;
	}
	return undefined;
}

describe("federation harness with an empty keyring", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness({ seedContentKey: false });
	}, 30_000);
	afterAll(async () => {
		await h.close();
	});

	it("asks the phone for epoch 1, installs the grant, and only then opens a value op", async () => {
		const request = await h.waitFor(async () => {
			const rows = await h.phone.inboxRead();
			const row = rows.find((candidate) => candidate.envelope.kind === "key_request");
			return row ? (h.phone.open(row) as KeyRequest) : undefined;
		}, "key request row");
		expect(request.epochs).toEqual([1]);
		expect(request.requesterSignPub).toBe(h.set.gateway.identity.sign.pub);

		const before = await h.phone.value({ kind: "list_dirs", path: "" });
		expect(before.result).toMatchObject({ kind: "refusal" });

		const { set } = h;
		const grant = await h.phone.send({
			kind: "key_grant",
			grant: {
				v: 1,
				recipientSignPub: set.gateway.identity.sign.pub,
				envelope: wrapContentKey(
					contentKeyOf(set),
					set.content.epoch,
					set.gateway.identity.box.pub,
					set.console.identity.sign.pub,
					set.console.identity.sign.priv,
				),
				at: h.now(),
			},
		});
		expect(grant).toMatchObject({ outcome: "accepted" });
		await h.waitFor(() => h.gateway.contentKeyStore.epochs().includes(1) || undefined, "installed epoch");

		const after = await h.phone.value({ kind: "list_dirs", path: "" });
		expect(after.result).toMatchObject({ entries: ["projects"] });
	});
});
