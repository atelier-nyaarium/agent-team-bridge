import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMigrationEpoch } from "../shared/migration-fence.js";
import { SHARE_TTL_MS, share, sharesFor, sweep } from "../shared/share-rules.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("cross-Domain gateway admission and relay", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	const sessions: FakeSession[] = [];
	let opId = 0;

	const remote = (peer: DomainPeer, team: string) => `${peer.set.domain.id}.${peer.set.gateway.id}.${team}`;
	const session = (peer: DomainPeer, team: string) => {
		const attached = attachFakeSession(peer.gateway, {
			team,
			conversationId: `conv-${team.replace(/\W/g, "-")}`,
		});
		sessions.push(attached);
		return attached;
	};
	/** One value op; the gateway writes the Router record and its own mirror. */
	const share = async (peer: DomainPeer, team: string, domainId: string) => {
		const target = { kind: "domain" as const, domainId };
		expect(await peer.phone.value({ kind: "cross_domain_share", sessionTarget: team, target })).toMatchObject({
			result: { ok: true },
		});
	};
	const sendFrom = async (peer: DomainPeer, to: string, domainId: string, body: string, id?: string) => {
		const operationId = id ?? `xd-${++opId}`;
		const accepted = await peer.phone.deliver(to, { kind: "send", to, domainId, body }, operationId);
		expect(accepted.outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await peer.phone.inboxRead()).find(
					(candidate) =>
						candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === operationId,
				),
			`send result ${operationId}`,
		);
		return peer.phone.open(row) as { ok: boolean };
	};

	beforeEach(async () => {
		h = await startFederationHarness();
		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk" });
		await h.link(h, bob);
	}, 60_000);

	afterEach(async () => {
		for (const attached of sessions.splice(0)) attached.close();
		if (h) await h.close();
	});

	it("admits shared sessions, filters presence, and rejects unshared destinations", async () => {
		const shared = session(bob, "fixture-app.shared");
		const hidden = session(bob, "fixture-app.hidden");
		await shared.ready();
		await hidden.ready();
		await share(bob, shared.team, h.set.domain.id);

		expect(await sendFrom(h, remote(bob, shared.team), "bob", "allowed")).toMatchObject({ ok: true });
		await h.waitFor(() => shared.inbound.find((frame) => frame.body === "allowed"), "shared delivery");
		expect(await sendFrom(h, remote(bob, hidden.team), "bob", "blocked")).toMatchObject({ ok: false });
		expect(hidden.inbound).toEqual([]);

		const presence = await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			const payload = planes.find((plane) => plane.name === "presence")?.payload as {
				linked?: Array<{ domainId: string; sessions: Array<{ team: string }> }>;
			};
			return payload.linked?.some(
				(entry) => entry.domainId === "bob" && entry.sessions.some((s) => s.team === shared.team),
			)
				? payload
				: undefined;
		}, "shared presence");
		expect(presence.linked?.find((entry) => entry.domainId === "bob")?.sessions.map((item) => item.team)).toEqual([
			shared.team,
		]);
	});

	it("writes the Router share record from a gateway frame, for that gateway's own sessions only", async () => {
		const owned = session(bob, "fixture-app.framed");
		await owned.ready();
		const target = { kind: "domain" as const, domainId: h.set.domain.id };
		const sessionTarget = remote(bob, owned.team);
		expect(
			(await bob.gateway.faults.routerInboxCall("cross_domain_share", { sessionTarget, target })).result,
		).toMatchObject({ ok: true });
		expect(await bob.phone.send({ kind: "cross_domain_list_shares" })).toMatchObject({
			shares: [{ sessionTarget, target }],
		});
		const foreign = `${bob.set.domain.id}.not-this-gateway.fixture-app.framed`;
		const refused = await bob.gateway.faults.routerInboxCall("cross_domain_share", {
			sessionTarget: foreign,
			target,
		});
		expect(refused.error).toMatch(/session/);
		expect(
			(await bob.gateway.faults.routerInboxCall("cross_domain_unshare", { sessionTarget, target })).result,
		).toMatchObject({ ok: true });
		expect(await bob.phone.send({ kind: "cross_domain_list_shares" })).toMatchObject({ shares: [] });
	});

	it("withdraws the Router record when the migration fence refuses the mirror", async () => {
		const fenced = session(bob, "fixture-app.fenced");
		await fenced.ready();
		const target = { kind: "domain" as const, domainId: h.set.domain.id };
		setMigrationEpoch(7);
		try {
			const refused = await bob.phone.value({ kind: "cross_domain_share", sessionTarget: fenced.team, target });
			expect(refused.result).toMatchObject({ kind: "refusal", reason: "migrating" });
		} finally {
			setMigrationEpoch(null);
		}
		expect(await bob.phone.send({ kind: "cross_domain_list_shares" })).toMatchObject({ shares: [] });
		await share(bob, fenced.team, h.set.domain.id);
		expect(await bob.phone.send({ kind: "cross_domain_list_shares" })).toMatchObject({
			shares: [{ sessionTarget: remote(bob, fenced.team), target }],
		});
	});

	it("rejects a cross-Domain wake for an unshared session before it reaches the session", async () => {
		const shared = session(bob, "fixture-app.wake");
		await shared.ready();
		await share(bob, shared.team, h.set.domain.id);
		shared.close();

		const refused = await sendFrom(h, remote(bob, "fixture-app.not-shared"), "bob", "wake blocked");
		expect(refused).toMatchObject({ ok: false });
		await new Promise((resolve) => setTimeout(resolve, 100));
		// bob.host is a real peer.
		expect(bob.host.wakes).toEqual([]);
	});

	it("returns only the verified sender's reply and preserves a job through a Router outage", async () => {
		const target = session(bob, "fixture-app.reply");
		await target.ready();
		await share(bob, target.team, h.set.domain.id);
		expect(await sendFrom(h, remote(bob, target.team), "bob", "question")).toMatchObject({ ok: true });
		const push = await h.waitFor(() => target.inbound.find((frame) => frame.body === "question"), "question");
		const carol = await h.addDomain({ domainId: "carol", gatewayId: "third" });
		await h.link(h, carol);
		await h.link(bob, carol);
		const carolFaults = carol.gateway.faults;
		const forgeTo = (peer: DomainPeer, op: Record<string, unknown>) => {
			const target = { domainId: peer.set.domain.id, gatewayId: peer.set.gateway.id };
			return carolFaults.routerCall("gateway_relay", {
				relayId: randomUUID(),
				srcGateway: carol.set.gateway.id,
				dstGateway: target.gatewayId,
				srcDomain: carol.set.domain.id,
				payload: { sealed: carolFaults.sealForPeer(target, op) },
			});
		};
		const forged = await forgeTo(h, {
			kind: "response_push",
			session_id: String(push.session_id),
			status: "completed",
			response: "forged",
		});
		expect(forged.result).toMatchObject({ ok: false });
		await share(bob, target.team, carol.set.domain.id);
		const relay = (op: Record<string, unknown>) => forgeTo(bob, op);
		const malformedRoute = await relay({
			kind: "send",
			from: "carol.third.app.dev",
			to: target.team,
			body: "wrong route",
			returnRoute: { srcGateway: "other", srcConversationId: "c1", srcSession: String(push.session_id) },
		});
		expect(malformedRoute.result).toMatchObject({ ok: false });
		const collision = await relay({
			kind: "send",
			from: "carol.third.app.dev",
			to: target.team,
			body: "collision",
			returnRoute: { srcGateway: "third", srcConversationId: "c1", srcSession: String(push.session_id) },
		});
		expect(collision.result).toMatchObject({ ok: false });

		await h.router.server.stop();
		expect((await target.reply(String(push.session_id), "answer")).status).toBe(200);
		await h.restartRouter();
		const replies = await h.waitFor(
			async () => {
				const found = h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.kind === "reply");
				return found.length > 0 ? found : undefined;
			},
			"cross-Domain reply",
			20_000,
		);
		expect(replies.filter((entry) => entry.body === "answer")).toHaveLength(1);
	});

	it("unlinks in-flight work and makes later sends fail at the destination", async () => {
		const target = session(bob, "fixture-app.unlink");
		await target.ready();
		await share(bob, target.team, h.set.domain.id);
		expect(await sendFrom(h, remote(bob, target.team), "bob", "before unlink")).toMatchObject({ ok: true });
		const push = await h.waitFor(() => target.inbound.find((frame) => frame.body === "before unlink"), "delivery");

		await h.phone.send({ kind: "cross_domain_unlink", domainId: "bob" });
		await h.waitFor(async () => {
			const listed = (await bob.phone.value({ kind: "cross_domain_list_peers" })).result as {
				peers?: Array<{ domainId: string }>;
			};
			return listed.peers?.every((peer) => peer.domainId !== h.set.domain.id) ? true : undefined;
		}, "peer unlink");
		expect((await target.reply(String(push.session_id), "after unlink")).status).toBe(404);
		expect(await sendFrom(h, remote(bob, target.team), "bob", "after unlink")).toMatchObject({ ok: false });
	});
});

describe("share expiry rules", () => {
	it("forgets an ended cross-Domain share while a live job keeps its share", () => {
		const initial = share({ shares: [] }, "bob.desk.live.dev", { kind: "domain", domainId: "alice" }, 0);
		const withEnded = share(initial, "bob.desk.ended.dev", { kind: "domain", domainId: "alice" }, 0);
		const result = sweep(withEnded, SHARE_TTL_MS + 1, SHARE_TTL_MS, (sessionTarget) =>
			sessionTarget.endsWith("live.dev"),
		);

		expect(result.removed).toBe(1);
		expect(sharesFor(result.state, "alice", () => true)).toEqual(["bob.desk.live.dev"]);
	});
});
