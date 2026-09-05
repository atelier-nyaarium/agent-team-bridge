import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../shared/canonical-json.js";
import { parseSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

interface DispatchResult {
	ok: boolean;
	error?: string;
}

interface LinkedEntry {
	domainId: string;
	sessions: Array<{ team: string; gatewayId: string }>;
}

describe("two linked Domains", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	const sessions: FakeSession[] = [];
	let opCounter = 0;
	const session = (peer: DomainPeer, team: string): FakeSession => {
		const attached = attachFakeSession(peer.gateway, { team, conversationId: `conv-${team.replace(/\W/g, "-")}` });
		sessions.push(attached);
		return attached;
	};
	const remote = (peer: DomainPeer, team: string) => `${peer.set.domain.id}.${peer.set.gateway.id}.${team}`;
	const peersOf = async (peer: DomainPeer) =>
		((await peer.phone.value({ kind: "cross_domain_list_peers" })).result as { peers: Array<{ domainId: string }> })
			.peers;
	const replies = async (peer: DomainPeer) =>
		peer.phone.entries(await peer.phone.inboxRead()).filter((entry) => entry.kind === "reply");
	/** Friend sessions on the presence plane. */
	const linkedSessions = async (peer: DomainPeer, domainId: string): Promise<string[]> => {
		const { planes } = await peer.phone.planesRead({});
		const presence = planes.find((plane) => plane.name === "presence")?.payload as
			| { linked?: LinkedEntry[] }
			| undefined;
		return presence?.linked?.find((entry) => entry.domainId === domainId)?.sessions.map((s) => s.team) ?? [];
	};
	/** A phone send's dispatch result. */
	const sendFrom = async (peer: DomainPeer, to: string, domainId: string, body: string): Promise<DispatchResult> => {
		const opId = `xd-${++opCounter}`;
		const accepted = await peer.phone.deliver(to, { kind: "send", to, domainId, body }, opId);
		expect(accepted.outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await peer.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`dispatch result for ${opId}`,
		);
		return peer.phone.open(row) as DispatchResult;
	};
	/** One value op; the gateway writes the Router record and its own mirror. */
	const share = async (peer: DomainPeer, team: string, toDomainId: string, kind: "share" | "unshare" = "share") => {
		const op = kind === "share" ? "cross_domain_share" : "cross_domain_unshare";
		const target = { kind: "domain" as const, domainId: toDomainId };
		const mirrored = await peer.phone.value({ kind: op, sessionTarget: team, target });
		expect(mirrored.result, JSON.stringify(mirrored.result)).toMatchObject({ ok: true });
	};

	beforeAll(async () => {
		h = await startFederationHarness();
		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk" });
	}, 60_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("links through the Router handshake: one safety code, both peer sets, a consumed pairing", async () => {
		const linked = await h.link(h, bob);
		expect(linked.receiver.sas).toBe(linked.sas);
		expect(linked.receiver.friendDomainId).toBe("bob");
		expect((await peersOf(h)).map((peer) => peer.domainId)).toEqual(["bob"]);
		expect((await peersOf(bob)).map((peer) => peer.domainId)).toEqual([h.set.domain.id]);
		const again = await bob.phone.value({
			kind: "cross_domain_confirm",
			pin: linked.pin,
			mySignedLink: linkStub(),
		});
		expect(again.result).toMatchObject({ kind: "refusal" });
	});

	it("delivers a send to a shared friend session and lands its reply in the sender's mailbox", async () => {
		const shared = session(bob, "fixture-app.shared");
		await shared.ready();
		await share(bob, shared.team, h.set.domain.id);

		const to = remote(bob, shared.team);
		expect(await sendFrom(h, to, "bob", "hello bob")).toMatchObject({ ok: true });
		const push = await h.waitFor(
			() => shared.inbound.find((frame) => frame.body === "hello bob"),
			"cross-Domain push",
		);
		expect((await shared.reply(String(push.session_id), "hi alice")).status).toBe(200);
		const reply = await h.waitFor(
			async () => (await replies(h)).find((entry) => entry.body === "hi alice"),
			"reply",
		);
		expect(reply.kind).toBe("reply");
	});

	it("projects the shared session onto the friend's presence plane, and unsharing removes it", async () => {
		await h.waitFor(
			async () => (await linkedSessions(h, "bob")).includes("fixture-app.shared") || undefined,
			"shared session on the friend's presence plane",
		);
		await share(bob, "fixture-app.shared", h.set.domain.id, "unshare");
		await h.waitFor(
			async () => !(await linkedSessions(h, "bob")).includes("fixture-app.shared") || undefined,
			"presence plane without the unshared session",
		);
	});

	it("refuses an unshared session the same way as a missing one", async () => {
		const hidden = session(bob, "fixture-app.hidden");
		await hidden.ready();
		const refusedHidden = await sendFrom(h, remote(bob, hidden.team), "bob", "?");
		const refusedMissing = await sendFrom(h, remote(bob, "fixture-app.nowhere"), "bob", "?");
		expect(refusedHidden.ok).toBe(false);
		expect(refusedMissing).toEqual(refusedHidden);
		expect(hidden.inbound).toEqual([]);
	});

	it("refuses the reply of a session unshared after the send", async () => {
		const brief = session(bob, "fixture-app.brief");
		await brief.ready();
		await share(bob, brief.team, h.set.domain.id);
		expect(await sendFrom(h, remote(bob, brief.team), "bob", "brief hello")).toMatchObject({ ok: true });
		const push = await h.waitFor(() => brief.inbound.find((frame) => frame.body === "brief hello"), "push");
		await share(bob, brief.team, h.set.domain.id, "unshare");
		expect((await brief.reply(String(push.session_id), "too late")).status).toBe(404);

		const marker = session(bob, "fixture-app.marker");
		await marker.ready();
		await share(bob, marker.team, h.set.domain.id);
		expect(await sendFrom(h, remote(bob, marker.team), "bob", "marker")).toMatchObject({ ok: true });
		const markerPush = await h.waitFor(
			() => marker.inbound.find((frame) => frame.body === "marker"),
			"marker push",
		);
		expect((await marker.reply(String(markerPush.session_id), "marker reply")).status).toBe(200);
		await h.waitFor(async () => (await replies(h)).find((entry) => entry.body === "marker reply"), "marker reply");
		expect((await replies(h)).map((entry) => entry.body)).not.toContain("too late");
	});

	it("unlinks at the Router: both gateways drop the peer, shares and routing to that Domain are gone", async () => {
		const unlinked = await h.phone.send({ kind: "cross_domain_unlink", domainId: "bob" });
		expect(unlinked).toMatchObject({ peersRemoved: 1 });
		await h.waitFor(async () => (await peersOf(h)).length === 0 || undefined, "home peers dropped");
		await h.waitFor(async () => (await peersOf(bob)).length === 0 || undefined, "friend peers dropped");
		await h.waitFor(async () => (await linkedSessions(h, "bob")).length === 0 || undefined, "friend sessions gone");
		const local = await h.phone.value({ kind: "cross_domain_unlink", domainId: "bob" });
		expect(local.result).toMatchObject({ peersRemoved: 0, sharesDropped: 0 });
		const marker = sessions.find((s) => s.team === "fixture-app.marker");
		expect(await sendFrom(h, remote(bob, "fixture-app.marker"), "bob", "after unlink")).toMatchObject({
			ok: false,
		});
		expect(marker?.inbound.some((frame) => frame.body === "after unlink")).toBe(false);
	});

	describe("a third Domain whose gateway id collides with the second's", () => {
		let carol: DomainPeer;

		beforeAll(async () => {
			carol = await h.addDomain({ domainId: "carol", gatewayId: bob.set.gateway.id });
			await h.link(h, carol);
			await h.link(h, bob);
		}, 60_000);

		it("routes a colliding gateway id by Domain, and a bare name stays local", async () => {
			const bobs = session(bob, "fixture-app.twin");
			await bobs.ready();
			await share(bob, bobs.team, h.set.domain.id);
			const carols = session(carol, "fixture-app.twin");
			await carols.ready();
			await share(carol, carols.team, h.set.domain.id);
			const local = session(h, "fixture-app.twin");
			await local.ready();

			expect(await sendFrom(h, remote(carol, carols.team), "carol", "to carol")).toMatchObject({ ok: true });
			await h.waitFor(() => carols.inbound.find((frame) => frame.body === "to carol"), "carol's push");
			expect(await sendFrom(h, remote(bob, bobs.team), "bob", "to bob")).toMatchObject({ ok: true });
			await h.waitFor(() => bobs.inbound.find((frame) => frame.body === "to bob"), "bob's push");
			expect((await h.phone.deliver(local.team, { kind: "send", to: local.team, body: "to home" })).outcome).toBe(
				"accepted",
			);
			await h.waitFor(() => local.inbound.find((frame) => frame.body === "to home"), "the local push");

			const bodies = (peer: FakeSession) => peer.inbound.map((frame) => frame.body);
			expect(bodies(carols)).toEqual(["to carol"]);
			expect(bodies(bobs)).toEqual(["to bob"]);
			expect(bodies(local)).toEqual(["to home"]);
		});

		it("lands a session's repeated cross-Domain send opId once, through the Router's ledger", async () => {
			const asker = session(h, "fixture-app.asker");
			await asker.ready();
			const answerer = session(carol, "fixture-app.answerer");
			await answerer.ready();
			await share(carol, answerer.team, h.set.domain.id);
			const body = {
				from: asker.team,
				fromConversationId: asker.conversationId,
				to: remote(carol, answerer.team),
				targetDomainId: "carol",
				body: "once across",
				opId: randomUUID(),
			};
			expect((await asker.post("/send", body)).status).toBe(200);
			expect((await asker.post("/send", body)).status).toBe(200);
			await h.waitFor(() => answerer.inbound.find((frame) => frame.body === "once across"), "delivery");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answerer.inbound.filter((frame) => frame.body === "once across")).toHaveLength(1);
		});

		it("refuses a reply forged by a linked third Domain into a job bound to another", async () => {
			const victim = session(bob, "fixture-app.victim");
			await victim.ready();
			await share(bob, victim.team, h.set.domain.id);
			expect(await sendFrom(h, remote(bob, victim.team), "bob", "for bob only")).toMatchObject({ ok: true });
			const push = await h.waitFor(() => victim.inbound.find((frame) => frame.body === "for bob only"), "push");
			const jobKey = String(push.session_id);

			const forged = await forgeReply(carol, h, jobKey, "carol was here");
			expect(forged).toMatchObject({ outcome: "accepted" });
			expect((await victim.reply(jobKey, "bob's answer")).status).toBe(200);
			await h.waitFor(
				async () => (await replies(h)).find((entry) => entry.body === "bob's answer"),
				"the real reply",
			);
			expect((await replies(h)).map((entry) => entry.body)).not.toContain("carol was here");

			expect(await forgeReply(carol, h, "fixture-app.nobody", "for no job")).toMatchObject({
				outcome: "accepted",
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect((await replies(h)).map((entry) => entry.body)).not.toContain("for no job");
		});
	});
});

/** A rogue peer's reply for a job it never held. */
async function forgeReply(from: DomainPeer, to: DomainPeer, jobKey: string, response: string): Promise<unknown> {
	const target = { domainId: to.set.domain.id, gatewayId: to.set.gateway.id };
	const op = { kind: "response_push", session_id: jobKey, response };
	const envelope = {
		origin: { kind: "gateway" as const, domainId: from.set.domain.id, gatewayId: from.set.gateway.id },
		opKey: { conversationId: sha256Hex(jobKey), opId: randomUUID() },
		epoch: "peer" as const,
		kind: "reply" as const,
		contentRefs: [],
	};
	const { project, session: sessionName } = parseSessionName(jobKey);
	const address = `session:${target.domainId}/${target.gatewayId}/${project}.${sessionName}`;
	return from.gateway.faults.forgePeerRow(target, address, envelope, op);
}

function linkStub() {
	return {
		link: {
			myOwnerSignPub: "AA==",
			peerOwnerSignPub: "AA==",
			peerDomainId: "nobody",
			peerGatewayId: "nowhere",
			peerSignPub: "AA==",
			peerBoxPub: "AA==",
			issuedAt: 0,
			nonce: "AA==",
		},
		ownerSignPub: "AA==",
		signature: "AA==",
	};
}
