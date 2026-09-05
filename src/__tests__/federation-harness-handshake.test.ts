import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HANDSHAKE_PENDING_TTL_MS, HANDSHAKE_REPUSH_DEDUPE_MS } from "../gateway/wsTypes.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { createFakeSocket, type FakeSocket } from "../testing/fakeSocket.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** Registers a channel socket without answering its handshake. */
function registerRaw(h: FederationHarness, sockets: FakeSocket[], team: string, subId: string): FakeSocket {
	const socket = createFakeSocket();
	sockets.push(socket);
	h.gateway.wsHandlers.open(socket.ws);
	h.gateway.wsHandlers.message(
		socket.ws,
		JSON.stringify({
			type: "register",
			team,
			subId,
			mode: "channel",
			conversationId: `conv-${team}-${subId}`.replace(/\W/g, "-"),
			version: "harness",
			deliveryProtocol: 1,
		}),
	);
	return socket;
}

const pushesOf = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "channel_push");

function rowOf(value: unknown, team: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const row = rowOf(item, team);
			if (row) return row;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.team === team) return record;
	for (const item of Object.values(record)) {
		const row = rowOf(item, team);
		if (row) return row;
	}
	return undefined;
}

describe("gateway session handshake lifecycle", () => {
	let h: FederationHarness;
	const clock = Date.now();
	const sessions: FakeSession[] = [];
	const sockets: FakeSocket[] = [];
	let counter = 0;

	const presenceRow = async (team: string) => {
		const { planes } = await h.phone.planesRead({});
		return rowOf(planes.find((plane) => plane.name === "presence")?.payload, team);
	};

	const session = (team: string, lead = true): FakeSession => {
		const attached = attachFakeSession(h.gateway, {
			team,
			conversationId: `conv-handshake-${++counter}`,
			lead,
		});
		sessions.push(attached);
		return attached;
	};

	const rawSession = (team: string, subId: string, isMainOrLead?: boolean): FakeSocket => {
		const socket = createFakeSocket();
		sockets.push(socket);
		h.gateway.wsHandlers.open(socket.ws);
		h.gateway.wsHandlers.message(
			socket.ws,
			JSON.stringify({
				type: "register",
				team,
				subId,
				mode: "channel",
				conversationId: `conv-raw-${team}-${subId}`.replace(/\W/g, "-"),
				version: "harness",
				deliveryProtocol: 1,
				...(isMainOrLead === undefined ? {} : { isMainOrLead }),
			}),
		);
		return socket;
	};

	beforeAll(async () => {
		h = await startFederationHarness({ now: () => clock });
	}, 30_000);

	afterAll(async () => {
		for (const socket of sockets) {
			socket.ws.close();
			h.gateway.wsHandlers.close(socket.ws);
		}
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("registers as verifying, confirms online, then resumes within retention", async () => {
		const automatic = session("fixture-app.auto");
		expect(await automatic.registered()).toMatchObject({ type: "register_ok" });
		await automatic.ready();
		expect(automatic.frames.filter((frame) => frame.type === "channel_push")).toHaveLength(1);

		const team = "fixture-app.handshake";
		const first = rawSession(team, "first");
		const firstPush = first.sent.find((frame) => frame.type === "channel_push");
		expect(firstPush).toBeDefined();
		expect(await presenceRow(team)).toBeUndefined();

		h.gateway.wsHandlers.resolveHandshake(String(firstPush?.session_id), { isMainOrLead: true });
		first.ws.close();
		h.gateway.wsHandlers.close(first.ws);

		const resumed = rawSession(team, "resumed", true);
		expect(resumed.sent.filter((frame) => frame.type === "channel_push")).toHaveLength(0);
	});

	it("keeps a newer registration after an older socket closes late", async () => {
		const team = "fixture-app.stale-close";
		const old = rawSession(team, "same");
		const replacement = rawSession(team, "same");
		const replacementPush = replacement.sent.find((frame) => frame.type === "channel_push");
		old.ws.close();
		h.gateway.wsHandlers.close(old.ws);
		h.gateway.wsHandlers.resolveHandshake(String(replacementPush?.session_id), { isMainOrLead: true });
		await h.phone.deliver(team, { kind: "send", to: team, body: "still routed" });
		await h.waitFor(
			() => replacement.sent.find((frame) => frame.type === "channel_push" && frame.body === "still routed"),
			"delivery to the replacement",
		);
		expect(old.sent.find((frame) => frame.body === "still routed")).toBeUndefined();
	});
});

describe("gateway handshake deadlines", () => {
	let h: FederationHarness;
	const clock = Date.now();
	const sockets: FakeSocket[] = [];

	beforeAll(async () => {
		h = await startFederationHarness({ now: () => clock, drive: "manual" });
	}, 30_000);

	afterAll(async () => {
		for (const socket of sockets) {
			socket.ws.close();
			h.gateway.wsHandlers.close(socket.ws);
		}
		if (h) await h.close();
	});

	it("re-sends the same handshake id once the throttle window passes", async () => {
		const team = "fixture-app.repush";
		const socket = registerRaw(h, sockets, team, "one");
		const first = pushesOf(socket)[0];
		expect(first).toBeDefined();

		expect(h.gateway.wsHandlers.repushHandshake(team, "one")).toBe("throttled");
		expect(pushesOf(socket)).toHaveLength(1);

		await h.ambient.advance(HANDSHAKE_REPUSH_DEDUPE_MS + 1);
		expect(h.gateway.wsHandlers.repushHandshake(team, "one")).toBe("pushed");

		const pushes = pushesOf(socket);
		expect(pushes).toHaveLength(2);
		expect(pushes[1]?.session_id).toBe(first?.session_id);
	});

	it("drops an unanswered handshake once the heartbeat passes its deadline", async () => {
		const team = "fixture-app.expire";
		const socket = registerRaw(h, sockets, team, "one");
		const pending = String(pushesOf(socket)[0]?.session_id);

		await h.ambient.advance(HANDSHAKE_PENDING_TTL_MS + 30_000);

		// Expiry drops the entry.
		expect(h.gateway.wsHandlers.resolveHandshake(pending, { isMainOrLead: true })).toBe(false);
		expect(pushesOf(socket)).toHaveLength(1);

		const revived = registerRaw(h, sockets, team, "two");
		await h.phone.deliver(team, { kind: "send", to: team, body: "after-expiry" });
		await h.waitFor(
			() => revived.sent.find((frame) => frame.type === "channel_push" && frame.body === "after-expiry"),
			"delivery after expiry",
		);
		expect(socket.sent.find((frame) => frame.body === "after-expiry")).toBeUndefined();
	});
});
