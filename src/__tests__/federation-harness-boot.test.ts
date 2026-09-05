import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveContentKey, wrapContentKey } from "../shared/content-envelope.js";
import { type Identity, seal } from "../shared/crypto.js";
import type { KeyRequest } from "../shared/schemasContentKey.js";
import { attachFakeSession } from "../testing/fakeSession.js";
import {
	type FederationHarness,
	type RouterOnlyHarness,
	startFederationHarness,
	startRouterOnly,
} from "../testing/federationHarness.js";

describe("federation harness cold start", () => {
	let h: RouterOnlyHarness;

	beforeEach(async () => {
		h = await startRouterOnly();
	}, 30_000);

	afterEach(async () => {
		if (h) await h.close();
	});

	it("answers reach before roster, then accepts the first signed gateway operation", async () => {
		const before = await h.phone.reach();
		expect(before.domainId).toBe(h.set.domain.id);
		expect(before.gateways).toEqual([]);

		const gateway = h.composeGateway();
		await h.waitFor(() => gateway.federation()?.routerClient.isRegistered() || undefined, "gateway registration");
		const after = await h.phone.reach();
		expect(after.gateways).toHaveLength(1);
		expect(after.gateways[0]?.gatewayId).toBe(h.set.gateway.id);
		const answer = await h.phone.send({ kind: "consumer_register", incarnation: 0 });
		expect(answer).toMatchObject({ cursor: expect.any(Number) });
		await gateway.close();
	});

	it("installs a bounded bootstrap and requests the missing earlier epoch", async () => {
		const nonce = "arming-nonce";
		// Admission precedes the bundle.
		const federationDir = path.join(h.root, "gateway", "federation");
		fs.mkdirSync(federationDir, { recursive: true });
		fs.writeFileSync(path.join(federationDir, "federation-identity.json"), JSON.stringify(h.set.gateway.identity));
		const gateway = h.composeGateway({ arming: true, enrollNonce: nonce });
		const gatewayIdentity: Identity = h.set.gateway.identity;
		const gatewayAdmission = h.set.gateway.admission;
		const contentKeys = [2, 3, 4].map((epoch) =>
			wrapContentKey(
				deriveContentKey(h.set.domain.owner.sign.priv, h.set.domain.id, epoch),
				epoch,
				gatewayIdentity.box.pub,
				h.set.console.identity.sign.pub,
				h.set.console.identity.sign.priv,
			),
		);
		const bundle = {
			nonce,
			transport: {
				routerUrl: `https://127.0.0.1:${h.router.port}`,
				routerCertFp: h.router.certFp,
				bearer: h.set.tokens.federation,
			},
			admission: gatewayAdmission,
			domain: {
				ownerSignPub: h.set.domain.owner.sign.pub,
				admissions: [gatewayAdmission, h.set.console.admission],
				revocations: [],
			},
			domainId: h.set.domain.id,
			contentKeys,
		};
		const frame = {
			v: 1,
			signerSignPub: h.set.console.identity.sign.pub,
			sealed: seal(
				Buffer.from(JSON.stringify(bundle)),
				gatewayIdentity.box.pub,
				h.set.console.identity.sign.priv,
			),
		};
		const response = await gateway.router(
			new Request("http://gateway.test/enroll", {
				method: "POST",
				body: JSON.stringify(frame),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(response.status).toBe(200);
		expect(gateway.contentKeyStore.epochs()).toEqual([2, 3, 4]);
		await h.waitFor(() => gateway.federation()?.routerClient.isRegistered() || undefined, "gateway registration");
		const request = await h.waitFor(async () => {
			const rows = await h.phone.inboxRead();
			const row = rows.find((candidate) => candidate.envelope.kind === "key_request");
			return row ? (h.phone.open(row) as KeyRequest) : undefined;
		}, "missing epoch request");
		expect(request.epochs).toEqual([1]);

		const grant = await h.phone.send({
			kind: "key_grant",
			grant: {
				v: 1,
				recipientSignPub: gatewayIdentity.sign.pub,
				envelope: wrapContentKey(
					deriveContentKey(h.set.domain.owner.sign.priv, h.set.domain.id, 1),
					1,
					gatewayIdentity.box.pub,
					h.set.console.identity.sign.pub,
					h.set.console.identity.sign.priv,
				),
				at: h.now(),
			},
		});
		expect(grant).toMatchObject({ outcome: "accepted" });
		await h.waitFor(() => gateway.contentKeyStore.epochs().includes(1) || undefined, "installed epoch 1");
		expect(gateway.contentKeyStore.epochs()).toEqual([1, 2, 3, 4]);
		await gateway.close();
	});
});

describe("federation harness routing and restart", () => {
	let h: FederationHarness;

	beforeEach(async () => {
		h = await startFederationHarness();
	}, 30_000);

	afterEach(async () => {
		if (h) await h.close();
	});

	it("fences the old incarnation and re-sends the presence baseline after a Router restart", async () => {
		const session = attachFakeSession(h.gateway, {
			team: "fixture-app.restart",
			conversationId: "conv-restart",
		});
		await session.ready();
		const before = h.gateway.federation()?.routerClient.incarnation();
		if (before === null || before === undefined) throw new Error("gateway incarnation is unavailable");
		await h.restartRouter();
		const after = await h.waitFor(() => h.gateway.federation()?.routerClient.incarnation(), "new incarnation");
		expect(after).toBeGreaterThan(before);
		const reach = await h.waitFor(async () => {
			const answer = await h.phone.reach();
			return answer.gateways.length > 0 ? answer : undefined;
		}, "gateway re-registration");
		expect(reach.gateways.map((gateway) => gateway.gatewayId)).toEqual([h.set.gateway.id]);
		const presence = await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			const plane = planes.find((candidate) => candidate.name === "presence");
			return plane && JSON.stringify(plane.payload).includes(session.team) ? plane : undefined;
		}, "session presence after Router restart");
		const rows = JSON.stringify(presence.payload).split(`"team":"${session.team}"`).length - 1;
		expect(rows).toBe(1);
		session.close();
	});

	it("converges to one presence row per team when a session reattaches after a gateway restart", async () => {
		const first = attachFakeSession(h.gateway, { team: "fixture-app.again", conversationId: "conv-again" });
		await first.ready();
		await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			return JSON.stringify(planes.find((plane) => plane.name === "presence")?.payload).includes(first.team);
		}, "presence before the restart");
		await h.restartGateway();
		const second = attachFakeSession(h.gateway, { team: "fixture-app.again", conversationId: "conv-again" });
		await second.ready();
		const presence = await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			const plane = planes.find((candidate) => candidate.name === "presence");
			const payload = JSON.stringify(plane?.payload);
			return payload.includes(`"team":"${second.team}"`) && payload.includes('"status":"online"')
				? plane
				: undefined;
		}, "presence after the restart");
		expect(JSON.stringify(presence.payload).split(`"team":"${second.team}"`).length - 1).toBe(1);
		first.close();
		second.close();
	});

	it("holds an owner notice through a Router outage and delivers it once after the restart", async () => {
		let launched: ReturnType<typeof attachFakeSession> | undefined;
		h.host.handlers.onCreateSession = (op) => {
			launched = attachFakeSession(h.gateway, {
				team: `${op.target.name}.${op.target.sessionName}`,
				conversationId: "conv-outage",
				sessionToken: op.sessionToken,
			});
		};
		const created = await h.phone.value({ kind: "create_session", target: "host", displayLabel: "Outage" });
		expect(created.result).toMatchObject({ created: true });
		const bound = await h.waitFor(() => launched, "the daemon's launch");
		await bound.ready();

		await h.router.server.stop();
		const posted = await bound.post("/human/notify", {
			from: bound.team,
			title: "While down",
			summary: "Posted during the outage.",
			full: "The Router was down when this was posted.",
		});
		expect(posted.status).toBe(200);
		await h.restartRouter();
		const notices = await h.waitFor(
			async () => {
				const found = h.phone
					.entries(await h.phone.inboxRead())
					.filter((entry) => entry.title === "While down");
				return found.length > 0 ? found : undefined;
			},
			"the held notice",
			20_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.title === "While down")).toHaveLength(
			notices.length,
		);
		expect(notices).toHaveLength(1);
		bound.close();
	});
});
